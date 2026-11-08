import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, fail, validEvaluateBody } from "./typesafe.ts";

export class UnknownSessionError extends Error {}
export class UnknownApprovalError extends Error {}

export interface UserInputAnswerInput {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

// The host behind the hub. Implemented by src/host.ts on the SDK facade;
// faked in tests. Nothing here imports the SDK.
export interface Host {
  readonly defaultSessionId: string;
  readonly serverInfo: unknown;
  readonly fingerprintWarning: string | undefined;
  onEvent(sub: (event: string, data: unknown) => void): () => void;
  startSession(profile?: string | null): Promise<string>;
  sendTurn(sessionId: string, text: string): Promise<{ turnId: string }>;
  cancelTurn(sessionId: string, turnId?: string): Promise<unknown>;
  decideApproval(sessionId: string, approvalId: string, choiceId: string): void;
  answerUserInput(sessionId: string, userInputId: string, answers: UserInputAnswerInput[]): Promise<unknown>;
  history(sessionId: string): { mode: "inline"; items: unknown[] };
  snapshot(sessionId: string): { sessionId: string; items: unknown[]; approvals: unknown[]; userInputs: unknown[] };
  listProfiles(): Promise<unknown>;
  close(): Promise<void>;
}

// File-relative so it works whether cwd is the root or server/.
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function validAnswers(body: unknown): body is { userInputId: string; answers: UserInputAnswerInput[] } {
  if (!body || typeof body !== "object") return false;
  const { userInputId, answers } = body as Record<string, unknown>;
  if (typeof userInputId !== "string" || !Array.isArray(answers) || answers.length === 0) return false;
  return answers.every((a) => {
    if (!a || typeof a !== "object") return false;
    const q = a as Record<string, unknown>;
    if (typeof q.questionId !== "string" || q.questionId.length === 0) return false;
    return (
      (["selectedLabel", "selectedLabels", "freeText"] as const).filter((k) => {
        const v = q[k];
        if (k === "selectedLabels")
          return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
        return typeof v === "string" && v.length > 0;
      }).length === 1
    );
  });
}

const sessionBody = {
  type: "object",
  properties: { profile: { type: ["string", "null"] } },
} as const;

const turnBody = {
  type: "object",
  properties: { sessionId: { type: ["string", "null"] }, text: { type: "string" } },
  required: ["text"],
} as const;

const cancelBody = {
  type: "object",
  properties: { sessionId: { type: ["string", "null"] }, turnId: { type: ["string", "null"] } },
} as const;

const approvalBody = {
  type: "object",
  properties: {
    sessionId: { type: ["string", "null"] },
    approvalId: { type: "string" },
    choiceId: { type: "string" },
  },
  required: ["approvalId", "choiceId"],
} as const;

// Smallest page cap: history/snapshot return the tail; pass ?limit= for more (max 200).
// shortcut: the slice runs after fold.items.list() materializes the full list;
// push the limit into the fold once the SDK supports bounded reads.
function queryLimit(query: unknown, fallback = 50): number {
  const raw = (query as { limit?: unknown } | undefined)?.limit;
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && (n as number) > 0 ? Math.min(n as number, 200) : fallback;
}

export function createServer(host: Host): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_000_000, requestTimeout: 30_000 });

  // Middleware: every response carries its own latency.
  const started = new WeakMap<object, number>();
  app.addHook("onRequest", (req, _reply, done) => {
    started.set(req, Date.now());
    done();
  });
  app.addHook("onSend", (req, reply, payload, done) => {
    reply.header("x-response-time", `${Date.now() - (started.get(req) ?? Date.now())}ms`);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'self'");
    done(null, payload);
  });

  // Generic messages only: never reflect ids, paths, or upstream detail.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UnknownSessionError) {
      reply.code(404).send({ error: "unknown session" });
      return;
    }
    if (err instanceof UnknownApprovalError) {
      reply.code(410).send({ error: "stale approval" });
      return;
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error(err);
      reply.code(500).send({ error: "internal error" });
      return;
    }
    if (status === 404) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.code(status).send({ error: "bad request" });
  });

  // SSE stream of hub events. Snapshot first so a reconnect recovers
  // missed items, approvals, and questions; the live tail follows.
  // The snapshot runs before headers, so a stale session gets a 404.
  app.get("/events", async (req, reply) => {
    const q = req.query as { sessionId?: string; limit?: string } | undefined;
    const sessionId = q?.sessionId ?? host.defaultSessionId;
    const snap = host.snapshot(sessionId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("ready", { sessionId });
    send("snapshot", { ...snap, items: snap.items.slice(-queryLimit(q)) });
    // One tab wants one session: drop other sessions here instead of making
    // every tab filter the full fan-out. Events without a session still pass.
    const off = host.onEvent((event, data) => {
      if (event !== "msp") {
        send(event, data);
        return;
      }
      const sid = (data as { params?: { sessionId?: unknown } } | null)?.params?.sessionId;
      if (sid === undefined || sid === sessionId) send(event, data);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  });

  app.get("/api/status", async () => ({
    sessionId: host.defaultSessionId,
    serverInfo: host.serverInfo,
    fingerprintWarning: host.fingerprintWarning ?? null,
  }));

  app.get("/api/profiles", async () => {
    try {
      return await host.listProfiles();
    } catch (e) {
      console.error("profiles:", e);
      return { profiles: [], error: "profiles unavailable" };
    }
  });

  app.post("/api/session", { schema: { body: sessionBody } }, async (req) => {
    const body = req.body as { profile?: string | null };
    try {
      const sessionId = await host.startSession(body.profile);
      return { sessionId, profile: body.profile ?? null };
    } catch (e) {
      req.log.error(e);
      fail(400, "bad request");
    }
  });

  app.get("/api/history", async (req) => {
    const q = req.query as { sessionId?: string; limit?: string } | undefined;
    const sessionId = q?.sessionId ?? host.defaultSessionId;
    const h = host.history(sessionId);
    return { history: { mode: h.mode, items: h.items.slice(-queryLimit(q)) } };
  });

  app.post("/api/turn", { schema: { body: turnBody } }, async (req) => {
    const body = req.body as { sessionId?: string; text?: string };
    if (typeof body.text !== "string" || !body.text.trim()) {
      fail(400, "text is required");
    }
    return host.sendTurn(body.sessionId ?? host.defaultSessionId, body.text);
  });

  app.post("/api/turn/cancel", { schema: { body: cancelBody } }, async (req) => {
    const body = req.body as { sessionId?: string; turnId?: string };
    return host.cancelTurn(body.sessionId ?? host.defaultSessionId, body.turnId);
  });

  // The facade answers through its parked approval handler, which checks the
  // choice against the server's current offer; no requirementId needed.
  app.post("/api/approval", { schema: { body: approvalBody } }, async (req) => {
    const body = req.body as { sessionId?: string; approvalId?: string; choiceId?: string };
    if (typeof body.approvalId !== "string" || typeof body.choiceId !== "string") {
      fail(400, "approvalId and choiceId are required");
    }
    host.decideApproval(body.sessionId ?? host.defaultSessionId, body.approvalId, body.choiceId);
    return { approvalId: body.approvalId, choiceId: body.choiceId };
  });

  app.post("/api/user-input", async (req) => {
    const body = req.body as { sessionId?: string } & Record<string, unknown>;
    if (!validAnswers(body)) {
      fail(400, "userInputId and one answer per question are required");
    }
    return host.answerUserInput(
      body.sessionId ?? host.defaultSessionId,
      body.userInputId,
      body.answers,
    );
  });

  // TypeSafe System One: typed judgments (choice/score/noul/box) over a state.
  // The hub forwards the call with its key; the browser never sees the secret.
  app.post("/api/evaluate", async (req, reply) => {
    if (!validEvaluateBody(req.body)) {
      return reply.code(400).send({ error: "state and at least one typed question are required" });
    }
    const { state, questions, model } = req.body;
    try {
      return await evaluate(state, questions, model);
    } catch (e) {
      req.log.error(e);
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      const code = status >= 400 && status < 600 ? status : 500;
      return reply.code(code).send({ error: code === 400 ? "bad request" : "evaluation failed" });
    }
  });

  // Static frontend. Unmatched methods and paths land here, as before.
  app.all("/*", async (req, reply) => {
    const url = new URL(req.raw.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.normalize(path.join(PUBLIC, file));
    if (!target.startsWith(PUBLIC + path.sep)) {
      return reply.code(404).send({ error: "not found" });
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      // SPA fallback: route-like paths serve the app shell so client routes load by deep link.
      if (!url.pathname.startsWith("/api/") && path.extname(url.pathname) === "") {
        try {
          await fs.promises.stat(path.join(PUBLIC, "index.html"));
        } catch {
          return reply.code(404).send({ error: "not found" });
        }
        return reply.type("text/html").header("Cache-Control", "no-cache").send(fs.createReadStream(path.join(PUBLIC, "index.html")));
      }
      return reply.code(404).send({ error: "not found" });
    }
    if (stat.isDirectory()) {
      return reply.code(404).send({ error: "not found" });
    }
    // shortcut: ETag has no If-None-Match/304 handling; add conditional GET when bandwidth matters.
    const ext = path.extname(target).toLowerCase();
    return reply
      .type(MIME[ext] ?? "application/octet-stream")
      .header("ETag", `"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`)
      .header("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600")
      .send(fs.createReadStream(target));
  });

  return app;
}
