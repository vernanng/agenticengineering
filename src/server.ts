import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { ChatHost, Subscriber } from "./host.ts";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
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

export function createServer(host: ChatHost): http.Server {
  const { msp, subscribers } = host;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // SSE stream of MSP notifications.
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send: Subscriber = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      subscribers.add(send);
      res.write(`event: ready\ndata: {"sessionId":${JSON.stringify(host.defaultSessionId)}}\n\n`);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(heartbeat);
        subscribers.delete(send);
      });
      return;
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      json(res, 200, {
        sessionId: host.defaultSessionId,
        serverInfo: msp.initializeResult.serverInfo,
        fingerprintWarning: msp.fingerprintWarning ?? null,
      });
      return;
    }

    if (url.pathname === "/api/profiles" && req.method === "GET") {
      json(res, 200, await msp.connection.command("permissionProfile/list", {}));
      return;
    }

    if (url.pathname === "/api/session" && req.method === "POST") {
      const body = (await readBody(req)) as { profile?: string | null };
      try {
        host.defaultSessionId = await host.startSession(body.profile);
      } catch (e) {
        json(res, 400, { error: String(e).slice(0, 300) });
        return;
      }
      json(res, 200, { sessionId: host.defaultSessionId, profile: body.profile ?? null });
      return;
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? host.defaultSessionId;
      json(
        res,
        200,
        await msp.connection.command("session/resume", { sessionId, excludeItems: false }),
      );
      return;
    }

    // Quickstart step 4: turn/start. The ack admits the turn; the answer streams over /events.
    if (url.pathname === "/api/turn" && req.method === "POST") {
      const body = (await readBody(req)) as { sessionId?: string; text?: string };
      if (!body.text?.trim()) {
        json(res, 400, { error: "text is required" });
        return;
      }
      json(
        res,
        200,
        await msp.connection.command("turn/start", {
          sessionId: body.sessionId ?? host.defaultSessionId,
          input: [{ type: "text", text: body.text }],
        }),
      );
      return;
    }

    // Quickstart step 6: turn/cancel, then wait for turn/completed with terminal "cancelled".
    if (url.pathname === "/api/turn/cancel" && req.method === "POST") {
      const body = (await readBody(req)) as { sessionId?: string; turnId?: string };
      json(
        res,
        200,
        await msp.connection.command("turn/cancel", {
          sessionId: body.sessionId ?? host.defaultSessionId,
          turnId: body.turnId,
        }),
      );
      return;
    }

    // Quickstart step 5: approval/decide. requirementId + choiceId come from approval/requested.
    if (url.pathname === "/api/approval" && req.method === "POST") {
      const body = (await readBody(req)) as {
        sessionId?: string;
        approvalId?: string;
        requirementId?: unknown;
        choiceId?: string;
      };
      json(
        res,
        200,
        await msp.connection.command("approval/decide", {
          sessionId: body.sessionId ?? host.defaultSessionId,
          approvalId: body.approvalId,
          requirementId: body.requirementId,
          choiceId: body.choiceId,
          feedback: null,
        }),
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
  });
}
