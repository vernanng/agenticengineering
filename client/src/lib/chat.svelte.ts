import { api, apiPost, itemText, type TrafficSink } from "./api.ts";
import { approvalTitle, approveOnceChoice, judgeApproval } from "./safety.ts";
import type { ApprovalRequest } from "../components/ApprovalCard.svelte";
import type { UserInputRequest } from "../components/UserInputCard.svelte";

export interface Profile {
  profileId: string;
  label: string;
  description?: string;
  available?: boolean;
}

export interface TrafficLine {
  id: number;
  dir: "in" | "out";
  label: string;
  text: string | null;
  title: string;
}

export type ApprovalVerdict =
  | { state: "checking" }
  | { state: "safe"; noul: number }
  | { state: "manual"; noul?: number };

export type Entry =
  | { type: "msg"; id: number; kind: string; text: string; cls: string; streaming: boolean }
  | { type: "term"; id: number; text: string }
  | { type: "approval"; id: number; request: ApprovalRequest; resolved: boolean; verdict?: ApprovalVerdict }
  | { type: "userinput"; id: number; request: UserInputRequest; settled: boolean };

export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Smallest bounds: entry list and per-message text stay flat no matter the session length.
const MAX_ENTRIES = 500;
const MAX_MSG_TEXT = 20000;

// Single owner of chat state + server wiring. Panels stay presentational:
// to move a panel, move its one component tag in App.svelte.
export class ChatStore {
  entries = $state<Entry[]>([]);
  traffic = $state<TrafficLine[]>([]);
  trafficHidden = $state(false);
  sessionId = $state<string | null>(null);
  runningTurnId = $state<string | null>(null);
  stopping = $state(false);
  profiles = $state<Profile[]>([]);
  selectedProfile = $state("");
  fingerprintWarning = $state("");
  bootError = $state<string | null>(null);

  nextId = 0;
  items = new Map<string, number>(); // itemId -> entry id
  entryById = new Map<number, Entry>(); // entry id -> entry, skips the full-list scan
  // shortcut: seenItems grows with lifetime itemIds; scope it per session reset only (see newSession).
  seenItems = new Set<string>();
  // Terminal lines for turns that ended before their ack arrived; folded on adopt, cleared on newSession.
  endedTurns = new Map<string, string>();
  pendingApprovals = new Set<string>();
  pendingInputs = new Set<string>();
  es: EventSource | null = null;
  sending = false;

  // shortcut: full-list filters per render; pending sets stay tiny (open cards only),
  // so an index would only pay off if entries grew past the MAX_ENTRIES cap.
  get pendingApprovalEntries() {
    return this.entries.filter((e) => e.type === "approval" && !e.resolved);
  }
  get pendingInputEntries() {
    return this.entries.filter((e) => e.type === "userinput" && !e.settled);
  }
  // Counters, not filters: bumped at the single pushEntry choke point.
  messageCount = $state(0);
  turnCount = $state(0);
  errorCount = $state(0);
  get connection() {
    return this.bootError ? "offline" : this.sessionId ? "live" : "starting";
  }

  sink: TrafficSink = (dir, label, data) => {
    const json = data === null || data === undefined ? null : JSON.stringify(data);
    this.traffic = [
      {
        id: this.nextId++,
        dir,
        label,
        text: json === null ? null : json.length > 1200 ? json.slice(0, 1200) + "…" : json,
        title: json ?? "",
      },
      ...this.traffic,
    ].slice(0, 80);
  };

  scrollScheduled = false;

  scroll() {
    // One rAF per burst, and never yank a user who scrolled up to read.
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    requestAnimationFrame(() => {
      this.scrollScheduled = false;
      if (window.innerHeight + window.scrollY < document.body.scrollHeight - 200) return;
      window.scrollTo(0, document.body.scrollHeight);
    });
  }

  countEntry(e: Entry, d: number) {
    if (e.type === "msg") {
      this.messageCount += d;
      if (e.kind === "error") this.errorCount += d;
    } else if (e.type === "term" && e.text.startsWith("turn ")) {
      this.turnCount += d;
    }
  }

  pushEntry(e: Entry) {
    this.entries.push(e);
    this.entryById.set(e.id, e);
    this.countEntry(e, 1);
    // shortcut: oldest-first eviction keeps open cards; revisit if caps shrink.
    if (this.entries.length > MAX_ENTRIES) {
      const idx = this.entries.findIndex((x) => {
        if (x.type === "approval") return x.resolved;
        if (x.type === "userinput") return x.settled;
        return true;
      });
      const [old] = this.entries.splice(idx === -1 ? 0 : idx, 1);
      this.entryById.delete(old.id);
      for (const [k, v] of this.items) if (v === old.id) this.items.delete(k);
      this.countEntry(old, -1);
    }
  }

  slotById(id: number | undefined): Entry | undefined {
    return id === undefined ? undefined : this.entryById.get(id);
  }

  pushTerm(text: string) {
    this.pushEntry({ type: "term", id: this.nextId++, text });
    this.scroll();
  }

  pushError(text: string) {
    this.pushEntry({ type: "msg", id: this.nextId++, kind: "error", text, cls: "", streaming: false });
    this.scroll();
  }

  renderHistory(history: { mode?: string; items?: unknown[] }) {
    if (history && history.mode === "inline" && Array.isArray(history.items)) {
      for (const item of history.items) {
        const it = item as { itemId?: string; kind?: string };
        if (typeof it?.itemId === "string") {
          if (this.seenItems.has(it.itemId)) continue;
          this.seenItems.add(it.itemId);
        }
        const kind = it?.kind || "message";
        this.pushEntry({
          type: "msg",
          id: this.nextId++,
          kind,
          text: itemText(item).slice(0, MAX_MSG_TEXT),
          cls: kind === "userMessage" ? "user" : "",
          streaming: false,
        });
      }
      this.scroll();
    }
  }

  finishTurn(turnId: string, text: string) {
    this.pushTerm(text);
    if (turnId === this.runningTurnId) {
      this.runningTurnId = null;
      this.stopping = false;
    }
  }

  route(method: string, params: Record<string, any>) {
    this.sink("in", method, params);
    if (!params || params.sessionId !== this.sessionId) return;
    if (method === "item/started") {
      const id = params.itemId ?? params.item?.itemId;
      const slotId = id != null ? this.items.get(id) : undefined;
      if (slotId !== undefined) {
        const slot = this.slotById(slotId);
        if (slot?.type === "msg") slot.streaming = true;
      } else {
        const entry: Entry = {
          type: "msg",
          id: this.nextId++,
          kind: params.item?.kind ?? "item",
          text: "",
          cls: "",
          streaming: true,
        };
        this.pushEntry(entry);
        if (id != null) this.items.set(id, entry.id);
      }
    } else if (method === "item/delta") {
      const slotId = this.items.get(params.itemId);
      if (slotId !== undefined) {
        const slot = this.slotById(slotId);
        // shortcut: streaming text stops at MAX_MSG_TEXT; item/completed then
        // replays the same head-truncated text, so giant outputs lose the tail.
        if (slot?.type === "msg") {
          if (slot.text.length < MAX_MSG_TEXT) slot.text += params.delta ?? "";
          this.scroll();
        }
      }
    } else if (method === "item/completed") {
      const id = params.itemId ?? params.item?.itemId;
      const slotId = id != null ? this.items.get(id) : undefined;
      const text = params.item ? itemText(params.item) : "";
      if (slotId !== undefined) {
        const slot = this.slotById(slotId);
        if (slot?.type === "msg") {
          slot.text = (text || slot.text).slice(0, MAX_MSG_TEXT);
          slot.streaming = false;
        }
      } else {
        this.pushEntry({
          type: "msg",
          id: this.nextId++,
          kind: params.item?.kind ?? "item",
          text: text.slice(0, MAX_MSG_TEXT),
          cls: "",
          streaming: false,
        });
      }
      if (id != null) this.seenItems.add(id);
      this.scroll();
    } else if (method === "turn/started") {
      this.runningTurnId = params.turnId;
    } else if (method === "turn/completed") {
      // Stale or duplicate completions (a turn/ended already folded this
      // turn, or a new turn started) must not print a second terminal line.
      // Still recorded: the ack may land after the end (see sendText).
      const completedText =
        `turn ${params.turnId} ${params.terminal}` +
        (params.error ? `: ${params.error.message ?? params.error.kind}` : "");
      this.endedTurns.set(params.turnId, completedText);
      if (params.turnId === this.runningTurnId) {
        this.endedTurns.delete(params.turnId);
        this.finishTurn(params.turnId, completedText);
      }
    } else if (method === "turn/ended") {
      // Server-authored outcome the live tail never carried (unqueued, host
      // death). Ignored when turn/completed already finished this turn.
      // Still recorded: the ack may land after the end (see sendText).
      const endedText = `turn ${params.turnId} ${params.terminal ?? params.outcome}`;
      this.endedTurns.set(params.turnId, endedText);
      if (params.turnId === this.runningTurnId) {
        this.endedTurns.delete(params.turnId);
        this.finishTurn(params.turnId, endedText);
      }
    } else if (method === "approval/failed") {
      this.pushTerm(`approval ${params.approvalId} failed: ${params.kind}`);
    } else if (method === "approval/requested") {
      if (!params) return;
      this.addApproval(params as ApprovalRequest);
      this.scroll();
    } else if (method === "approval/resolved") {
      const entry = this.entries.find(
        (e) => e.type === "approval" && e.request.approvalId === params.approvalId,
      );
      if (entry?.type === "approval") entry.resolved = true;
      this.pendingApprovals.delete(params.approvalId);
    } else if (method === "approval/updated") {
      const entry = this.entries.find(
        (e) => e.type === "approval" && e.request.approvalId === params.approvalId,
      );
      if (entry?.type === "approval" && Array.isArray(params.availableChoices)) {
        entry.request = params as ApprovalRequest;
        void this.tryAutoApprove(entry.id);
      }
    } else if (method === "userInput/requested") {
      if (!params || this.pendingInputs.has(params.userInputId)) return;
      this.pendingInputs.add(params.userInputId);
      this.pushEntry({ type: "userinput", id: this.nextId++, request: params as UserInputRequest, settled: false });
      this.scroll();
    } else if (method === "userInput/settled") {
      const entry = this.entries.find(
        (e) => e.type === "userinput" && e.request.userInputId === params.userInputId,
      );
      if (entry?.type === "userinput") entry.settled = true;
      this.pendingInputs.delete(params.userInputId);
    }
  }

  applySnapshot(snap: {
    sessionId?: string;
    items?: unknown[];
    approvals?: ApprovalRequest[];
    userInputs?: UserInputRequest[];
  }) {
    if (!snap || snap.sessionId !== this.sessionId) return;
    this.renderHistory({ mode: "inline", items: snap.items ?? [] });
    for (const a of snap.approvals ?? []) {
      if (a) this.addApproval(a);
    }
    for (const u of snap.userInputs ?? []) {
      if (u && !this.pendingInputs.has(u.userInputId)) {
        this.pendingInputs.add(u.userInputId);
        this.pushEntry({ type: "userinput", id: this.nextId++, request: u, settled: false });
      }
    }
    this.scroll();
  }

  watchSession() {
    if (this.es) this.es.close();
    this.es = new EventSource("/events?sessionId=" + encodeURIComponent(this.sessionId ?? "") + "&limit=50");
    this.es.addEventListener("msp", (e) => {
      const { method, params } = JSON.parse((e as MessageEvent).data);
      this.route(method, params);
    });
    this.es.addEventListener("snapshot", (e) =>
      this.applySnapshot(JSON.parse((e as MessageEvent).data)),
    );
  }

  async newSession() {
    const s = (await apiPost(
      "/api/session",
      { profile: this.selectedProfile ? this.selectedProfile : null },
      this.sink,
    )) as { sessionId: string };
    this.sessionId = s.sessionId;
    this.runningTurnId = null;
    this.stopping = false;
    this.entries = [];
    this.entryById.clear();
    this.messageCount = 0;
    this.turnCount = 0;
    this.errorCount = 0;
    this.items.clear();
    this.pendingApprovals.clear();
    this.pendingInputs.clear();
    this.endedTurns.clear();
    this.seenItems.clear();
    this.watchSession();
  }

  async init() {
    const status = (await api("/api/status", undefined, this.sink)) as {
      sessionId: string;
      fingerprintWarning?: string;
    };
    const catalog = (await api("/api/profiles", undefined, this.sink)) as {
      profiles?: Profile[];
      error?: string;
    };
    this.profiles = (catalog.profiles ?? []).filter((p) => p.available);
    if (catalog.error) this.pushTerm("Could not load permission profiles: " + catalog.error);
    this.sessionId = status.sessionId;
    if (status.fingerprintWarning)
      this.fingerprintWarning = "Host protocol differs from this SDK: " + status.fingerprintWarning;
    const resumed = (await api(
      "/api/history?sessionId=" + encodeURIComponent(this.sessionId) + "&limit=50",
      undefined,
      this.sink,
    )) as { history: { mode?: string; items?: unknown[] } };
    this.renderHistory(resumed.history);
    this.watchSession();
  }

  // False when the text was not consumed (a turn is already running): the
  // caller must keep it in the composer instead of clearing the box.
  async sendText(raw: string): Promise<boolean> {
    const text = raw.trim();
    if (!text || this.runningTurnId || this.sending) return false;
    this.sending = true;
    this.pushEntry({ type: "msg", id: this.nextId++, kind: "you", text, cls: "user", streaming: false });
    this.scroll();
    try {
      const ack = (await apiPost(
        "/api/turn",
        { sessionId: this.sessionId, text },
        this.sink,
      )) as { turnId: string };
      this.runningTurnId = ack.turnId;
      const terminal = this.endedTurns.get(ack.turnId);
      if (terminal !== undefined) {
        // The turn ended before its ack arrived: fold the outcome now
        // instead of adopting a dead id (the composer would wedge).
        this.endedTurns.delete(ack.turnId);
        this.finishTurn(ack.turnId, terminal);
      } else if (this.stopping) {
        // Stop arrived mid-send with no id to cancel: re-issue it now.
        void this.stopTurn();
      }
      return true;
    } catch (err) {
      this.pushError("Could not send: " + (err as Error).message);
      return false;
    } finally {
      this.sending = false;
    }
  }

  async stopTurn() {
    const turnId = this.runningTurnId;
    this.stopping = true;
    try {
      await apiPost("/api/turn/cancel", { sessionId: this.sessionId, turnId }, this.sink);
    } catch (err) {
      this.stopping = false;
      this.pushError("Could not stop the turn: " + (err as Error).message);
    }
  }

  settleUserInput(entry: Entry, userInputId: string) {
    if (entry?.type === "userinput") entry.settled = true;
    this.pendingInputs.delete(userInputId);
  }

  // One parked approval: show its card, then let Jev vote. A clear safe vote
  // auto-approves the one-shot grant; anything else stays a human decision.
  lookupApproval(id: number): Extract<Entry, { type: "approval" }> | undefined {
    const e = this.slotById(id);
    return e?.type === "approval" ? e : undefined;
  }

  addApproval(request: ApprovalRequest) {
    if (!request || this.pendingApprovals.has(request.approvalId)) return;
    this.pendingApprovals.add(request.approvalId);
    const id = this.nextId++;
    this.pushEntry({ type: "approval", id, request, resolved: false });
    void this.judgeEntry(id);
  }

  async judgeEntry(id: number) {
    const entry = this.lookupApproval(id);
    if (!entry) return;
    entry.verdict = { state: "checking" };
    const v = await judgeApproval(entry.request, this.sink);
    const live = this.lookupApproval(id);
    if (!live || live.resolved) return;
    if (!v || !v.safe) {
      live.verdict = { state: "manual", noul: v?.noul };
      return;
    }
    live.verdict = { state: "safe", noul: v.noul };
    await this.tryAutoApprove(id);
  }

  async tryAutoApprove(id: number) {
    const entry = this.lookupApproval(id);
    const verdict = entry?.verdict;
    if (!entry || entry.resolved || verdict?.state !== "safe") return;
    const choices = entry.request.availableChoices ?? [];
    const choice = approveOnceChoice(choices);
    if (!choice) {
      // No narrow grant offered (or choices not in yet): a safe vote alone
      // never approves. Wait for choices; fall back to manual once they land.
      if (choices.length > 0) entry.verdict = { state: "manual", noul: verdict.noul };
      return;
    }
    try {
      await apiPost(
        "/api/approval",
        {
          sessionId: this.sessionId,
          approvalId: entry.request.approvalId,
          choiceId: choice.choiceId,
        },
        this.sink,
      );
      this.pushTerm(`Jev auto-approved ${approvalTitle(entry.request)} (safe ${verdict.noul}).`);
    } catch (e) {
      entry.verdict = { state: "manual", noul: verdict.noul };
      this.pushError("Jev auto-approve failed, your call: " + (e as Error).message);
    }
  }

  destroy() {
    this.es?.close();
    this.es = null;
  }
}

export const chat = new ChatStore();
