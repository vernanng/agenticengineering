import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer, UnknownApprovalError, UnknownSessionError } from "../src/server.ts";

function fakeHost() {
  const calls: unknown[][] = [];
  const subs = new Set<(event: string, data: unknown) => void>();
  const host = {
    defaultSessionId: "sess-1",
    serverInfo: { name: "test" },
    fingerprintWarning: undefined,
    onEvent: (sub: (event: string, data: unknown) => void) => {
      subs.add(sub);
      return () => {
        subs.delete(sub);
      };
    },
    startSession: async () => "sess-2",
    sendTurn: async (sessionId: string, text: string) => {
      calls.push(["sendTurn", sessionId, text]);
      if (sessionId !== "sess-1") throw new UnknownSessionError(sessionId);
      return { turnId: "turn-1" };
    },
    cancelTurn: async (sessionId: string, turnId?: string) => {
      calls.push(["cancelTurn", sessionId, turnId]);
      return { sessionId, turnId: turnId ?? null };
    },
    decideApproval: (sessionId: string, approvalId: string, choiceId: string) => {
      calls.push(["decideApproval", sessionId, approvalId, choiceId]);
      if (approvalId !== "appr-1") throw new UnknownApprovalError(approvalId);
    },
    answerUserInput: async (sessionId: string, userInputId: string, answers: unknown[]) => {
      calls.push(["answerUserInput", sessionId, userInputId, answers]);
      if (sessionId !== "sess-1") throw new UnknownSessionError(sessionId);
      return { userInputId, status: "answered" };
    },
    history: (sessionId: string) => {
      if (sessionId !== "sess-1") throw new UnknownSessionError(sessionId);
      return { mode: "inline" as const, items: [{ itemId: "i1", kind: "userMessage", text: "hi" }] };
    },
    snapshot: (sessionId: string) => {
      if (sessionId !== "sess-1") throw new UnknownSessionError(sessionId);
      return { sessionId, items: [], approvals: [], userInputs: [] };
    },
    listProfiles: async () => ({ profiles: [] }),
    close: async () => {},
  };
  const fire = (event: string, data: unknown) => {
    for (const sub of subs) sub(event, data);
  };
  return { calls, host, fire };
}

async function withServer(host: Parameters<typeof createServer>[0], fn: (base: string) => Promise<void>) {
  const server = createServer(host);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

describe("hub routes", () => {
  it("starts a turn and returns its id", async () => {
    const { calls, host } = fakeHost();
    await withServer(host, async (base) => {
      const { status, json } = await post(base, "/api/turn", { sessionId: "sess-1", text: "hi" });
      assert.equal(status, 200);
      assert.deepEqual(json, { turnId: "turn-1" });
      assert.deepEqual(calls, [["sendTurn", "sess-1", "hi"]]);
    });
  });

  it("rejects empty turns and unknown sessions", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      assert.equal((await post(base, "/api/turn", { sessionId: "sess-1", text: "  " })).status, 400);
      assert.equal((await post(base, "/api/turn", { sessionId: "nope", text: "hi" })).status, 404);
    });
  });

  it("decides approvals and answers questions, 410/400 on stale or bad input", async () => {
    const { calls, host } = fakeHost();
    await withServer(host, async (base) => {
      const ok = await post(base, "/api/approval", {
        sessionId: "sess-1",
        approvalId: "appr-1",
        choiceId: "allow-once",
      });
      assert.equal(ok.status, 200);
      const stale = await post(base, "/api/approval", {
        sessionId: "sess-1",
        approvalId: "appr-old",
        choiceId: "allow-once",
      });
      assert.equal(stale.status, 410);

      const answer = await post(base, "/api/user-input", {
        sessionId: "sess-1",
        userInputId: "q1",
        answers: [{ questionId: "a", selectedLabel: "Yes" }],
      });
      assert.equal(answer.status, 200);
      assert.equal((await post(base, "/api/user-input", { sessionId: "sess-1", userInputId: "q1" })).status, 400);
      assert.equal(
        (await post(base, "/api/user-input", { sessionId: "sess-1", userInputId: "q1", answers: [] })).status,
        400,
      );
      assert.deepEqual(
        calls.filter((c) => c[0] === "answerUserInput"),
        [["answerUserInput", "sess-1", "q1", [{ questionId: "a", selectedLabel: "Yes" }]]],
      );
    });
  });

  it("serves history from the fold", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const res = await fetch(`${base}/api/history?sessionId=sess-1`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        history: { mode: "inline", items: [{ itemId: "i1", kind: "userMessage", text: "hi" }] },
      });
    });
  });

  it("answers unknown api paths with json, not text", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const res = await fetch(`${base}/api/nope`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not found" });
    });
  });

  it("rejects answers that set two fields or miss the question", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const bad = (answers: unknown) => post(base, "/api/user-input", { sessionId: "sess-1", userInputId: "q1", answers });
      assert.equal((await bad([{ questionId: "a", selectedLabel: "X", freeText: "Y" }])).status, 400);
      assert.equal((await bad([{ questionId: "", selectedLabel: "X" }])).status, 400);
      assert.equal((await bad([{ questionId: "a", selectedLabels: ["X", 7] }])).status, 400);
    });
  });

  it("only streams events for the connected session", async () => {
    const { host, fire } = fakeHost();
    await withServer(host, async (base) => {
      const seen = await new Promise<string>((resolve, reject) => {
        let buf = "";
        let fired = false;
        const req = http.get(`${base}/events?sessionId=sess-1`, { headers: { Accept: "text/event-stream" } }, (res) => {
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            if (!fired && buf.includes("event: snapshot")) {
              fired = true;
              fire("msp", { method: "item/started", params: { sessionId: "other", itemId: "x" } });
              fire("msp", { method: "turn/started", params: { sessionId: "sess-1", turnId: "t9" } });
            }
          });
        });
        req.on("error", reject);
        setTimeout(() => {
          req.destroy();
          resolve(buf);
        }, 400);
      });
      assert.match(seen, /t9/);
      assert.doesNotMatch(seen, /"itemId":"x"/);
    });
  });

  it("streams ready then a snapshot on connect", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const seen = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("no snapshot streamed")), 3000);
        const req = http.get(`${base}/events?sessionId=sess-1`, { headers: { Accept: "text/event-stream" } }, (res) => {
          assert.equal(res.headers["content-type"], "text/event-stream");
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            if (buf.includes("event: snapshot")) {
              clearTimeout(timer);
              req.destroy();
              resolve(buf);
            }
          });
        });
        req.on("error", reject);
      });
      assert.match(seen, /event: ready/);
      assert.match(seen, /"sessionId":"sess-1"/);
    });
  });
});
