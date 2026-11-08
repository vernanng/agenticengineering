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
  let trafficHidden = $state(true);
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

<header>
  <h1>Muse Chat</h1>
  <span class="sess">{sessionId ?? ""}</span>
  <select bind:value={selectedProfile} onchange={newSession} title="Permission profile for new chats">
    <option value="">Host default</option>
    {#each profiles as p}
      <option value={p.profileId} title={p.description ?? ""}>{p.label}</option>
    {/each}
  </select>
  <button class="ghost" onclick={() => (trafficHidden = !trafficHidden)}>Traffic</button>
  <button class="ghost" onclick={newSession}>New chat</button>
</header>
{#if fingerprintWarning}
  <div id="warn">{fingerprintWarning}</div>
{/if}
{#if bootError}
  <div id="warn">
    {bootError}
    <button
      class="ghost"
      style="margin-top:8px;"
      onclick={() => {
        bootError = null;
        init().catch((e) => (bootError = "Could not reach the chat server. (" + e.message + ")"));
      }}
    >Retry</button>
  </div>
{/if}
<main id="log">
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
</main>
<div id="traffic" hidden={trafficHidden}>
  {#each traffic as t (t.id)}
    <div class={t.dir === "in" ? "tin" : "tout"}>{t.dir === "in" ? "← " : "→ "}{t.label}</div>
    {#if t.text !== null}
      <pre title={t.title}>{t.text}</pre>
    {/if}
  {/each}
</div>
<footer>
  <form onsubmit={send}>
    <input bind:value={composerText} autocomplete="off" placeholder="Ask Muse anything about this workspace…" />
    {#if runningTurnId}
      <button type="button" disabled={stopping} onclick={stop}>Stop</button>
    {:else}
      <button type="submit">Send</button>
    {/if}
  </form>
</footer>
