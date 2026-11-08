// Durable conversation log: persist-before-show JSONL mirror of each session.
// Clean-room port of the durable core of @earendil-works/pi-durable
// (https://github.com/earendil-works/pi/tree/main/packages/durable):
// immutable entries, storage backends, reopen-marks-pending-failed.
// Model wiring is deliberately absent: turns execute on the MSP/SDK Host
// (host.ts) and approvals are judged by JEV (judge.ts).

import fs from "node:fs";
import path from "node:path";

export type DurableKind = "user" | "outcome";
export type DurableStatus = "pending" | "done" | "failed";

export interface DurableEntry {
  entryId: string;
  sessionId: string;
  turnId: string | null;
  kind: DurableKind;
  status: DurableStatus;
  text: string;
  createdAt: string;
}

export class StorageRequestError extends Error {}

export interface DurableStore {
  sessions(): string[];
  list(sessionId: string): DurableEntry[];
  pendingTurns(sessionId: string): DurableEntry[];
  append(sessionId: string, kind: DurableKind, text: string): DurableEntry;
  attachTurn(entryId: string, turnId: string): void;
  failEntry(entryId: string, text?: string): void;
  settleTurn(turnId: string, status: "done" | "failed", text?: string): void;
  reopen(): void;
  close(): void;
}

let nextId = 1;

function newEntry(sessionId: string, kind: DurableKind, text: string): DurableEntry {
  return {
    entryId: `e${Date.now().toString(36)}-${nextId++}`,
    sessionId,
    turnId: null,
    kind,
    status: "pending",
    text,
    createdAt: new Date().toISOString(),
  };
}

function validEntry(value: unknown): value is DurableEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.entryId === "string" &&
    typeof e.sessionId === "string" &&
    (e.turnId === null || typeof e.turnId === "string") &&
    (e.kind === "user" || e.kind === "outcome") &&
    (e.status === "pending" || e.status === "done" || e.status === "failed") &&
    typeof e.text === "string"
  );
}

// Crash recovery core, shared by both backends: a turn still pending at
// reopen died with the process, so it ends as failed instead of vanishing.
// Stale completions can never resurrect a settled entry.
function markReopened(log: DurableEntry[]): void {
  for (const e of log) {
    if (e.status === "pending") e.status = "failed";
  }
}

// Marks the admission settled and records the outcome. Unknown or already
// settled turns are ignored: late completions must not resurrect entries.
function settle(log: DurableEntry[], turnId: string, status: "done" | "failed", text?: string): DurableEntry[] {
  const admitted = log.find((e) => e.kind === "user" && e.turnId === turnId && e.status === "pending");
  if (!admitted) return [];
  admitted.status = status;
  const outcome: DurableEntry = {
    ...newEntry(admitted.sessionId, "outcome", text ?? `turn ${status}`),
    turnId,
    status,
  };
  log.push(outcome);
  return [admitted, outcome];
}

export function createMemoryDurable(): DurableStore {
  const logs = new Map<string, DurableEntry[]>();
  const byId = new Map<string, DurableEntry>();
  const logFor = (sessionId: string): DurableEntry[] => {
    let log = logs.get(sessionId);
    if (!log) {
      log = [];
      logs.set(sessionId, log);
    }
    return log;
  };
  const logOfTurn = (turnId: string): DurableEntry[] => {
    for (const log of logs.values()) {
      if (log.some((e) => e.turnId === turnId)) return log;
    }
    return [];
  };
  return {
    sessions: () => [...logs.keys()],
    list: (sessionId) => [...(logs.get(sessionId) ?? [])],
    pendingTurns: (sessionId) => (logs.get(sessionId) ?? []).filter((e) => e.status === "pending"),
    append(sessionId, kind, text) {
      const entry = newEntry(sessionId, kind, text);
      logFor(sessionId).push(entry);
      byId.set(entry.entryId, entry);
      return { ...entry };
    },
    attachTurn(entryId, turnId) {
      const entry = byId.get(entryId);
      if (entry && entry.turnId === null) entry.turnId = turnId;
    },
    failEntry(entryId, text) {
      const entry = byId.get(entryId);
      if (entry && entry.status === "pending") {
        entry.status = "failed";
        if (text !== undefined) entry.text = text;
      }
    },
    settleTurn: (turnId, status, text) => {
      settle(logOfTurn(turnId), turnId, status, text);
    },
    reopen: () => {
      for (const log of logs.values()) markReopened(log);
    },
    close: () => {},
  };
}

// JSONL files, one per session, fsynced on every append. Reopening the same
// directory recovers prior sessions; entries pending at reopen died mid-turn.
// shortcut: the file is an op log (mutations re-append the entry); switch to
// sqlite if per-line rewrite cost ever matters.
export function createFileDurable(dir: string): DurableStore {
  const fileFor = (sessionId: string): string =>
    path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  const fds = new Map<string, number>();
  const logs = new Map<string, DurableEntry[]>();
  const byId = new Map<string, DurableEntry>();
  // Later lines win: mutations re-append the full entry under its entryId.
  const remember = (entry: DurableEntry): void => {
    const known = byId.get(entry.entryId);
    if (known) {
      Object.assign(known, entry);
      return;
    }
    let log = logs.get(entry.sessionId);
    if (!log) {
      log = [];
      logs.set(entry.sessionId, log);
    }
    log.push(entry);
    byId.set(entry.entryId, entry);
  };
  const fdFor = (sessionId: string): number => {
    let fd = fds.get(sessionId);
    if (fd === undefined) {
      fd = fs.openSync(fileFor(sessionId), "a");
      fds.set(sessionId, fd);
    }
    return fd;
  };
  const persist = (entry: DurableEntry): void => {
    const fd = fdFor(entry.sessionId);
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  };
  const persistEach = (entries: DurableEntry[]): void => {
    for (const entry of entries) persist(entry);
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry: unknown = JSON.parse(line);
        if (validEntry(entry)) remember(entry);
      }
    }
  } catch (e) {
    throw new StorageRequestError(`cannot open durable dir ${dir}: ${(e as Error).message}`);
  }
  for (const log of logs.values()) markReopened(log);
  const logOfTurn = (turnId: string): DurableEntry[] => {
    for (const log of logs.values()) {
      if (log.some((e) => e.turnId === turnId)) return log;
    }
    return [];
  };
  let closed = false;
  return {
    sessions: () => [...logs.keys()],
    list: (sessionId) => [...(logs.get(sessionId) ?? [])],
    pendingTurns: (sessionId) => (logs.get(sessionId) ?? []).filter((e) => e.status === "pending"),
    append(sessionId, kind, text) {
      if (closed) throw new StorageRequestError("durable store is closed");
      const entry = newEntry(sessionId, kind, text);
      try {
        persist(entry);
      } catch (e) {
        throw new StorageRequestError(`cannot append for ${sessionId}: ${(e as Error).message}`);
      }
      remember(entry);
      return { ...entry };
    },
    attachTurn(entryId, turnId) {
      const entry = byId.get(entryId);
      if (entry && entry.turnId === null) {
        entry.turnId = turnId;
        try {
          persist(entry);
        } catch {
          // The admission line is already on disk; the turn link stays in memory.
        }
      }
    },
    failEntry(entryId, text) {
      const entry = byId.get(entryId);
      if (entry && entry.status === "pending") {
        entry.status = "failed";
        if (text !== undefined) entry.text = text;
        try {
          persist(entry);
        } catch {
          // Admission line already persists the failure; retried at reopen.
        }
      }
    },
    settleTurn(turnId, status, text) {
      persistEach(settle(logOfTurn(turnId), turnId, status, text));
    },
    reopen: () => {
      for (const log of logs.values()) markReopened(log);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const fd of fds.values()) fs.closeSync(fd);
      fds.clear();
    },
  };
}

// Fold-shaped items for dead (post-restart) sessions: the client renders any
// { itemId, kind, text } via itemText, so user admissions replay as user
// messages and outcomes as plain messages. Live sessions keep serving the
// SDK fold untouched.
export function durableHistoryItems(sessionId: string, store: DurableStore): unknown[] {
  return store
    .list(sessionId)
    .filter((e) => e.kind === "user" || e.kind === "outcome")
    .map((e) => ({
      itemId: e.entryId,
      kind: e.kind === "user" ? "userMessage" : "message",
      text: e.kind === "user" ? e.text : `${e.text} [${e.status}]`,
    }));
}
