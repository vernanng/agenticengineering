import http from "node:http";
import fs from "node:fs";
import path from "node:path";

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

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const PUBLIC = path.join(process.cwd(), "public");

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function statusOf(e: unknown): number {
  if (e instanceof UnknownSessionError) return 404;
  if (e instanceof UnknownApprovalError) return 410;
  return 500;
}

function validAnswers(body: unknown): body is { userInputId: string; answers: UserInputAnswerInput[] } {
  if (!body || typeof body !== "object") return false;
  const { userInputId, answers } = body as Record<string, unknown>;
  if (typeof userInputId !== "string" || !Array.isArray(answers) || answers.length === 0) return false;
  return answers.every(
    (a) =>
      !!a &&
      typeof a === "object" &&
      typeof (a as Record<string, unknown>).questionId === "string" &&
      (["selectedLabel", "selectedLabels", "freeText"] as const).filter((k) => {
        const v = (a as Record<string, unknown>)[k];
        return k === "selectedLabels" ? Array.isArray(v) && v.length > 0 : typeof v === "string" && v.length > 0;
      }).length === 1,
  );
}

async function route(host: Host, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  // SSE stream of hub events. Snapshot first so a reconnect recovers
  // missed items, approvals, and questions; the live tail follows.
  if (url.pathname === "/events" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? host.defaultSessionId;
    const snap = host.snapshot(sessionId);
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
    const off = host.onEvent(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    json(res, 200, {
      sessionId: host.defaultSessionId,
      serverInfo: host.serverInfo,
      fingerprintWarning: host.fingerprintWarning ?? null,
    });
    return;
  }

  if (url.pathname === "/api/profiles" && req.method === "GET") {
    try {
      json(res, 200, await host.listProfiles());
    } catch (e) {
      console.error("profiles:", e);
      json(res, 200, { profiles: [] });
    }
    return;
  }

  if (url.pathname === "/api/session" && req.method === "POST") {
    const body = (await readBody(req)) as { profile?: string | null };
    try {
      const sessionId = await host.startSession(body.profile);
      json(res, 200, { sessionId, profile: body.profile ?? null });
    } catch (e) {
      json(res, 400, { error: String(e).slice(0, 300) });
    }
    return;
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? host.defaultSessionId;
    json(res, 200, { history: host.history(sessionId) });
    return;
  }

  if (url.pathname === "/api/turn" && req.method === "POST") {
    const body = (await readBody(req)) as { sessionId?: string; text?: string };
    if (typeof body.text !== "string" || !body.text.trim()) {
      json(res, 400, { error: "text is required" });
      return;
    }
    json(res, 200, await host.sendTurn(body.sessionId ?? host.defaultSessionId, body.text));
    return;
  }

  if (url.pathname === "/api/turn/cancel" && req.method === "POST") {
    const body = (await readBody(req)) as { sessionId?: string; turnId?: string };
    if (body.turnId !== undefined && typeof body.turnId !== "string") {
      json(res, 400, { error: "turnId must be a string" });
      return;
    }
    json(res, 200, await host.cancelTurn(body.sessionId ?? host.defaultSessionId, body.turnId));
    return;
  }

  // The facade answers through its parked approval handler, which checks the
  // choice against the server's current offer; no requirementId needed.
  if (url.pathname === "/api/approval" && req.method === "POST") {
    const body = (await readBody(req)) as { sessionId?: string; approvalId?: string; choiceId?: string };
    if (typeof body.approvalId !== "string" || typeof body.choiceId !== "string") {
      json(res, 400, { error: "approvalId and choiceId are required" });
      return;
    }
    host.decideApproval(body.sessionId ?? host.defaultSessionId, body.approvalId, body.choiceId);
    json(res, 200, { approvalId: body.approvalId, choiceId: body.choiceId });
    return;
  }

  if (url.pathname === "/api/user-input" && req.method === "POST") {
    const body = (await readBody(req)) as { sessionId?: string } & Record<string, unknown>;
    if (!validAnswers(body)) {
      json(res, 400, { error: "userInputId and one answer per question are required" });
      return;
    }
    json(
      res,
      200,
      await host.answerUserInput(body.sessionId ?? host.defaultSessionId, body.userInputId, body.answers),
    );
    return;
  }

  // Static frontend.
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.normalize(path.join(PUBLIC, file));
  if (!target.startsWith(PUBLIC) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = target.endsWith(".html")
    ? "text/html"
    : target.endsWith(".js")
      ? "text/javascript"
      : "text/plain";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(target).pipe(res);
}

export function createServer(host: Host): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await route(host, req, res);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, statusOf(e), { error: String(e).slice(0, 300) });
    }
  });
}
