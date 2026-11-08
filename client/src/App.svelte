<script lang="ts">
  import { onMount } from "svelte";
  import { api, itemText, type TrafficSink } from "./lib/api";
  import ApprovalCard, { type ApprovalRequest } from "./components/ApprovalCard.svelte";
  import UserInputCard, { type UserInputRequest } from "./components/UserInputCard.svelte";

  interface Profile {
    profileId: string;
    label: string;
    description?: string;
    available?: boolean;
  }

  interface TrafficLine {
    id: number;
    dir: "in" | "out";
    label: string;
    text: string | null;
    title: string;
  }

  type Entry =
    | { type: "msg"; id: number; kind: string; text: string; cls: string; streaming: boolean }
    | { type: "term"; id: number; text: string }
    | { type: "approval"; id: number; request: ApprovalRequest; resolved: boolean }
    | { type: "userinput"; id: number; request: UserInputRequest; settled: boolean };

  let entries = $state<Entry[]>([]);
  let traffic = $state<TrafficLine[]>([]);
  let trafficHidden = $state(false);
  let sessionId = $state<string | null>(null);
  let runningTurnId = $state<string | null>(null);
  let stopping = $state(false);
  let profiles = $state<Profile[]>([]);
  let selectedProfile = $state("");
  let fingerprintWarning = $state("");
  let bootError = $state<string | null>(null);
  let composerText = $state("");
  let nextId = 0;

  const items = new Map<string, number>(); // itemId -> entry id
  const entryById = new Map<number, Entry>(); // entry id -> entry, skips the full-list scan
  const seenItems = new Set<string>();

  const pendingApprovalEntries = $derived(entries.filter((e) => e.type === "approval" && !e.resolved));
  const pendingInputEntries = $derived(entries.filter((e) => e.type === "userinput" && !e.settled));
  const messageCount = $derived(entries.filter((e) => e.type === "msg").length);
  const turnCount = $derived(
    entries.filter((e) => e.type === "term" && e.text.startsWith("turn ")).length,
  );
  const errorCount = $derived(entries.filter((e) => e.type === "msg" && e.kind === "error").length);
  const connection = $derived(bootError ? "offline" : sessionId ? "live" : "starting");

  function approvalTitle(r: ApprovalRequest): string {
    return r.subject?.title ?? r.toolCallId ?? r.subject?.kind ?? "tool call";
  }

  function scrollToId(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function pushEntry(e: Entry) {
    entries.push(e);
    entryById.set(e.id, e);
  }

  function slotById(id: number | undefined): Entry | undefined {
    return id === undefined ? undefined : entryById.get(id);
  }
  const pendingApprovals = new Set<string>();
  const pendingInputs = new Set<string>();
  let es: EventSource | null = null;

  const sink: TrafficSink = (dir, label, data) => {
    const json = data === null || data === undefined ? null : JSON.stringify(data);
    traffic = [
      {
        id: nextId++,
        dir,
        label,
        text: json === null ? null : json.length > 1200 ? json.slice(0, 1200) + "…" : json,
        title: json ?? "",
      },
      ...traffic,
    ].slice(0, 80);
  };

  function scroll() {
    window.scrollTo(0, document.body.scrollHeight);
  }

  function pushTerm(text: string) {
    pushEntry({ type: "term", id: nextId++, text });
    scroll();
  }

  function pushError(text: string) {
    pushEntry({ type: "msg", id: nextId++, kind: "error", text, cls: "", streaming: false });
    scroll();
  }

  function renderHistory(history: { mode?: string; items?: unknown[] }) {
    if (history && history.mode === "inline" && Array.isArray(history.items)) {
      for (const item of history.items) {
        const it = item as { itemId?: string; kind?: string };
        if (typeof it?.itemId === "string") {
          if (seenItems.has(it.itemId)) continue;
          seenItems.add(it.itemId);
        }
        const kind = it?.kind || "message";
        pushEntry({
          type: "msg",
          id: nextId++,
          kind,
          text: itemText(item),
          cls: kind === "userMessage" ? "user" : "",
          streaming: false,
        });
      }
      scroll();
    }
  }

  function finishTurn(turnId: string, text: string) {
    pushTerm(text);
    if (turnId === runningTurnId) {
      runningTurnId = null;
      stopping = false;
    }
  }

  function route(method: string, params: Record<string, any>) {
    sink("in", method, params);
    if (!params || params.sessionId !== sessionId) return;
    if (method === "item/started") {
      const id = params.itemId ?? params.item?.itemId;
      const slotId = id != null ? items.get(id) : undefined;
      if (slotId !== undefined) {
        const slot = slotById(slotId);
        if (slot?.type === "msg") slot.streaming = true;
      } else {
        const entry: Entry = {
          type: "msg",
          id: nextId++,
          kind: params.item?.kind ?? "item",
          text: "",
          cls: "",
          streaming: true,
        };
        pushEntry(entry);
        if (id != null) items.set(id, entry.id);
      }
    } else if (method === "item/delta") {
      const slotId = items.get(params.itemId);
      if (slotId !== undefined) {
        const slot = slotById(slotId);
        if (slot?.type === "msg") {
          slot.text += params.delta ?? "";
          scroll();
        }
      }
    } else if (method === "item/completed") {
      const id = params.itemId ?? params.item?.itemId;
      const slotId = id != null ? items.get(id) : undefined;
      const text = params.item ? itemText(params.item) : "";
      if (slotId !== undefined) {
        const slot = slotById(slotId);
        if (slot?.type === "msg") {
          slot.text = text || slot.text;
          slot.streaming = false;
        }
      } else {
        pushEntry({
          type: "msg",
          id: nextId++,
          kind: params.item?.kind ?? "item",
          text,
          cls: "",
          streaming: false,
        });
      }
      if (id != null) seenItems.add(id);
      scroll();
    } else if (method === "turn/started") {
      runningTurnId = params.turnId;
    } else if (method === "turn/completed") {
      finishTurn(
        params.turnId,
        `turn ${params.turnId} ${params.terminal}` +
          (params.error ? `: ${params.error.message ?? params.error.kind}` : ""),
      );
    } else if (method === "turn/ended") {
      // Server-authored outcome the live tail never carried (unqueued, host
      // death). Ignored when turn/completed already finished this turn.
      if (params.turnId === runningTurnId) {
        finishTurn(params.turnId, `turn ${params.turnId} ${params.terminal ?? params.outcome}`);
      }
    } else if (method === "approval/failed") {
      pushTerm(`approval ${params.approvalId} failed: ${params.kind}`);
    } else if (method === "approval/requested") {
      if (!params || pendingApprovals.has(params.approvalId)) return;
      pendingApprovals.add(params.approvalId);
      pushEntry({ type: "approval", id: nextId++, request: params as ApprovalRequest, resolved: false });
      scroll();
    } else if (method === "approval/resolved") {
      const entry = entries.find(
        (e) => e.type === "approval" && e.request.approvalId === params.approvalId,
      );
      if (entry?.type === "approval") entry.resolved = true;
    } else if (method === "approval/updated") {
      const entry = entries.find(
        (e) => e.type === "approval" && e.request.approvalId === params.approvalId,
      );
      if (entry?.type === "approval" && Array.isArray(params.availableChoices)) {
        entry.request = params as ApprovalRequest;
      }
    } else if (method === "userInput/requested") {
      if (!params || pendingInputs.has(params.userInputId)) return;
      pendingInputs.add(params.userInputId);
      pushEntry({ type: "userinput", id: nextId++, request: params as UserInputRequest, settled: false });
      scroll();
    } else if (method === "userInput/settled") {
      const entry = entries.find(
        (e) => e.type === "userinput" && e.request.userInputId === params.userInputId,
      );
      if (entry?.type === "userinput") entry.settled = true;
      pendingInputs.delete(params.userInputId);
    }
  }

  function applySnapshot(snap: {
    sessionId?: string;
    items?: unknown[];
    approvals?: ApprovalRequest[];
    userInputs?: UserInputRequest[];
  }) {
    if (!snap || snap.sessionId !== sessionId) return;
    renderHistory({ mode: "inline", items: snap.items ?? [] });
    for (const a of snap.approvals ?? []) {
      if (a && !pendingApprovals.has(a.approvalId)) {
        pendingApprovals.add(a.approvalId);
        pushEntry({ type: "approval", id: nextId++, request: a, resolved: false });
      }
    }
    for (const u of snap.userInputs ?? []) {
      if (u && !pendingInputs.has(u.userInputId)) {
        pendingInputs.add(u.userInputId);
        pushEntry({ type: "userinput", id: nextId++, request: u, settled: false });
      }
    }
    scroll();
  }

  function watchSession() {
    if (es) es.close();
    es = new EventSource("/events?sessionId=" + encodeURIComponent(sessionId ?? ""));
    es.addEventListener("msp", (e) => {
      const { method, params } = JSON.parse((e as MessageEvent).data);
      route(method, params);
    });
    es.addEventListener("snapshot", (e) => applySnapshot(JSON.parse((e as MessageEvent).data)));
  }

  async function newSession() {
    const s = (await api(
      "/api/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: selectedProfile ? selectedProfile : null }),
      },
      sink,
    )) as { sessionId: string };
    sessionId = s.sessionId;
    runningTurnId = null;
    stopping = false;
    entries = [];
    entryById.clear();
    items.clear();
    pendingApprovals.clear();
    pendingInputs.clear();
    seenItems.clear();
    watchSession();
  }

  async function init() {
    const status = (await api("/api/status", undefined, sink)) as {
      sessionId: string;
      fingerprintWarning?: string;
    };
    const catalog = (await api("/api/profiles", undefined, sink)) as { profiles?: Profile[]; error?: string };
    profiles = (catalog.profiles ?? []).filter((p) => p.available);
    if (catalog.error) pushTerm("Could not load permission profiles: " + catalog.error);
    sessionId = status.sessionId;
    if (status.fingerprintWarning) fingerprintWarning = "Host protocol differs from this SDK: " + status.fingerprintWarning;
    const resumed = (await api(
      "/api/history?sessionId=" + encodeURIComponent(sessionId),
      undefined,
      sink,
    )) as { history: { mode?: string; items?: unknown[] } };
    renderHistory(resumed.history);
    watchSession();
  }

  let sending = false;

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const text = composerText.trim();
    if (!text || runningTurnId || sending) return;
    composerText = "";
    sending = true;
    pushEntry({ type: "msg", id: nextId++, kind: "you", text, cls: "user", streaming: false });
    scroll();
    try {
      const ack = (await api(
        "/api/turn",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, text }),
        },
        sink,
      )) as { turnId: string };
      runningTurnId = ack.turnId;
    } catch (err) {
      pushError("Could not send: " + (err as Error).message);
    } finally {
      sending = false;
    }
  }

  async function stop() {
    const turnId = runningTurnId;
    stopping = true;
    try {
      await api(
        "/api/turn/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, turnId }),
        },
        sink,
      );
    } catch (err) {
      stopping = false;
      pushError("Could not stop the turn: " + (err as Error).message);
    }
  }

  onMount(() => {
    init().catch((e) => {
      bootError = "Could not reach the chat server. Start it with npm run dev, then retry. (" + e.message + ")";
    });
    return () => es?.close();
  });
</script>

<header class="topbar">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <div class="brandtext">
      <h1>Agent Engineering</h1>
      <span class="sub">Session operations</span>
    </div>
  </div>
  <div class="topmeta">
    <span class="status" data-state={connection}>
      <span class="dot" aria-hidden="true"></span>
      {connection === "live" ? (runningTurnId ? "working" : "live") : connection}
    </span>
    {#if runningTurnId}
      <span class="runid" title={runningTurnId}>turn {runningTurnId.slice(0, 8)}…</span>
    {/if}
    <span class="sess" title={sessionId ?? ""}>{sessionId ?? "connecting…"}</span>
  </div>
  <div class="topactions">
    <label class="visually-hidden" for="profile">Permission profile</label>
    <select id="profile" bind:value={selectedProfile} onchange={newSession} title="Permission profile for new chats">
      <option value="">Host default</option>
      {#each profiles as p}
        <option value={p.profileId} title={p.description ?? ""}>{p.label}</option>
      {/each}
    </select>
    <button class="ghost" onclick={() => (trafficHidden = !trafficHidden)} aria-expanded={!trafficHidden}>
      {trafficHidden ? "Show traffic" : "Hide traffic"}
    </button>
    <button class="ghost" onclick={newSession}>New chat</button>
  </div>
</header>

<div class="shell">
  <aside class="side" aria-label="Session overview">
    <nav aria-label="Dashboard sections">
      <button class="navlink" onclick={() => scrollToId("panel-chat")}>Chat</button>
      <button class="navlink" onclick={() => scrollToId("panel-attention")}>
        Approvals
        {#if pendingApprovalEntries.length + pendingInputEntries.length > 0}
          <span class="badge">{pendingApprovalEntries.length + pendingInputEntries.length}</span>
        {/if}
      </button>
      <button class="navlink" onclick={() => scrollToId("panel-traffic")}>Traffic</button>
      <button class="navlink" onclick={() => scrollToId("panel-session")}>Session</button>
    </nav>

    <section class="panel" aria-label="Run figures">
      <h2>Run figures</h2>
      <dl class="stats">
        <div><dt>Messages</dt><dd>{messageCount}</dd></div>
        <div><dt>Turns done</dt><dd>{turnCount}</dd></div>
        <div><dt>Open approvals</dt><dd>{pendingApprovalEntries.length}</dd></div>
        <div><dt>Open questions</dt><dd>{pendingInputEntries.length}</dd></div>
        <div><dt>Traffic events</dt><dd>{traffic.length}</dd></div>
        <div><dt>Errors</dt><dd>{errorCount}</dd></div>
      </dl>
    </section>

    <section class="panel" id="panel-session" aria-label="Session details">
      <h2>Session</h2>
      <p class="sessfull">{sessionId ?? "connecting…"}</p>
      <p class="muted">
        {runningTurnId ? `Turn ${runningTurnId} running.` : "Idle. Send a message to start a turn."}
      </p>
      {#if fingerprintWarning}
        <p class="warn">{fingerprintWarning}</p>
      {/if}
    </section>
  </aside>

  <main class="center" id="panel-chat">
    {#if fingerprintWarning}
      <div class="warnbanner" role="status">{fingerprintWarning}</div>
    {/if}
    {#if bootError}
      <div class="warnbanner" role="alert">
        {bootError}
        <button
          class="ghost"
          onclick={() => {
            bootError = null;
            init().catch((e) => (bootError = "Could not reach the chat server. (" + e.message + ")"));
          }}
        >Retry</button>
      </div>
    {/if}

    <div id="log" aria-live="polite">
      {#each entries as e (e.id)}
        {#if e.type === "msg"}
          <div class="msg {e.cls}" class:streaming={e.streaming}>
            <div class="kind">{e.kind}</div>
            <div>{e.text}</div>
          </div>
        {:else if e.type === "term"}
          <div class="terminal">{e.text}</div>
        {:else if e.type === "approval"}
          <ApprovalCard
            request={e.request}
            {sessionId}
            resolved={e.resolved}
            {sink}
            onDecided={pushTerm}
            onError={pushError}
          />
        {:else if e.type === "userinput"}
          <UserInputCard
            request={e.request}
            {sessionId}
            settled={e.settled}
            {sink}
            onSettled={() => {
              e.settled = true;
              pendingInputs.delete(e.request.userInputId);
            }}
            onError={pushError}
          />
        {/if}
      {/each}
      {#if entries.length === 0}
        <div class="empty">
          <h2>No activity yet</h2>
          <p>Send the first message below. Turns, tool output, approvals, and questions appear here in order.</p>
        </div>
      {/if}
    </div>
  </main>

  <aside class="inspector" aria-label="Attention and traffic">
    <section class="panel" id="panel-attention" aria-label="Needs attention">
      <h2>Needs attention</h2>
      {#if pendingApprovalEntries.length === 0 && pendingInputEntries.length === 0}
        <p class="muted">All clear. New approvals and tool questions will queue here.</p>
      {:else}
        <ul class="queue">
          {#each pendingApprovalEntries as e (e.id)}
            {#if e.type === "approval"}
              <li><span class="tag">approval</span> {approvalTitle(e.request)}</li>
            {/if}
          {/each}
          {#each pendingInputEntries as e (e.id)}
            {#if e.type === "userinput"}
              <li>
                <span class="tag">question</span>
                {e.request.toolName ?? "tool"} · {(e.request.questions ?? []).length} question{(e.request.questions ?? []).length === 1 ? "" : "s"}
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </section>

    <section class="panel" id="panel-traffic" aria-label="Protocol traffic" hidden={trafficHidden}>
      <h2>Traffic</h2>
      {#if traffic.length === 0}
        <p class="muted">No API or stream events yet.</p>
      {:else}
        <ol class="trafficlist">
          {#each traffic as t (t.id)}
            <li>
              <div class={t.dir === "in" ? "tin" : "tout"}>{t.dir === "in" ? "← " : "→ "}{t.label}</div>
              {#if t.text !== null}
                <pre title={t.title}>{t.text}</pre>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  </aside>
</div>

<footer>
  <form onsubmit={send}>
    <label class="visually-hidden" for="composer">Message Muse</label>
    <input
      id="composer"
      bind:value={composerText}
      autocomplete="off"
      placeholder="Ask Muse anything about this workspace…"
    />
    {#if runningTurnId}
      <button type="button" disabled={stopping} onclick={stop}>Stop</button>
    {:else}
      <button type="submit">Send</button>
    {/if}
  </form>
</footer>
