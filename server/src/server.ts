import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, validEvaluateBody } from "./typesafe.ts";

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
  properties: { sessionId: { type: "string" }, text: { type: "string" } },
  required: ["text"],
} as const;

const cancelBody = {
  type: "object",
  properties: { sessionId: { type: "string" }, turnId: { type: "string" } },
} as const;

const approvalBody = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    approvalId: { type: "string" },
    choiceId: { type: "string" },
  },
  required: ["approvalId", "choiceId"],
} as const;

export function createServer(host: Host): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_000_000 });

  // Middleware: every response carries its own latency.
  const started = new WeakMap<object, number>();
  app.addHook("onRequest", (req, _reply, done) => {
    started.set(req, Date.now());
    done();
  });
  app.addHook("onSend", (req, reply, payload, done) => {
    reply.header("x-response-time", `${Date.now() - (started.get(req) ?? Date.now())}ms`);
    done(null, payload);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UnknownSessionError) {
      reply.code(404).send({ error: err.message.slice(0, 300) });
      return;
    }
    if (err instanceof UnknownApprovalError) {
      reply.code(410).send({ error: err.message.slice(0, 300) });
      return;
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error(err);
      reply.code(500).send({ error: "internal error" });
      return;
    }
    reply.code(status).send({ error: err.message.slice(0, 300) });
  });

  // SSE stream of hub events. Snapshot first so a reconnect recovers
  // missed items, approvals, and questions; the live tail follows.
  // The snapshot runs before headers, so a stale session gets a 404.
  app.get("/events", async (req, reply) => {
    const sessionId =
      (req.query as { sessionId?: string } | undefined)?.sessionId ?? host.defaultSessionId;
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
    send("snapshot", snap);
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
      return { profiles: [], error: String(e).slice(0, 300) };
    }
  });

  app.post("/api/session", { schema: { body: sessionBody } }, async (req) => {
    const body = req.body as { profile?: string | null };
    try {
      const sessionId = await host.startSession(body.profile);
      return { sessionId, profile: body.profile ?? null };
    } catch (e) {
      throw Object.assign(new Error(String(e).slice(0, 300)), { statusCode: 400 });
    }
  });

  app.get("/api/history", async (req) => {
    const sessionId =
      (req.query as { sessionId?: string } | undefined)?.sessionId ?? host.defaultSessionId;
    return { history: host.history(sessionId) };
  });

  app.post("/api/turn", { schema: { body: turnBody } }, async (req) => {
    const body = req.body as { sessionId?: string; text?: string };
    if (typeof body.text !== "string" || !body.text.trim()) {
      throw Object.assign(new Error("text is required"), { statusCode: 400 });
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
      throw Object.assign(new Error("approvalId and choiceId are required"), { statusCode: 400 });
    }
    host.decideApproval(body.sessionId ?? host.defaultSessionId, body.approvalId, body.choiceId);
    return { approvalId: body.approvalId, choiceId: body.choiceId };
  });

  app.post("/api/user-input", async (req) => {
    const body = req.body as { sessionId?: string } & Record<string, unknown>;
    if (!validAnswers(body)) {
      throw Object.assign(new Error("userInputId and one answer per question are required"), {
        statusCode: 400,
      });
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
      // The shared handler would mask 5xx as "internal error"; keep the cause.
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      if (status >= 500) req.log.error(e);
      return reply.code(status).send({ error: String((e as Error).message).slice(0, 300) });
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
      return reply.code(404).send("not found");
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
          return reply.code(404).send("not found");
        }
        return reply.type("text/html").send(fs.createReadStream(path.join(PUBLIC, "index.html")));
      }
      return reply.code(404).send("not found");
    }
    if (stat.isDirectory()) {
      return reply.code(404).send("not found");
    }
    return reply
      .type(MIME[path.extname(target).toLowerCase()] ?? "text/plain")
      .send(fs.createReadStream(target));
  });

  return app;
}
