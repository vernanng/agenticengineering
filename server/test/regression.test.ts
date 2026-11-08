import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, UnknownApprovalError, UnknownSessionError } from "../src/server.ts";
import { approveOnceChoice } from "../../client/src/lib/safety.ts";

// Fake Host seam: mirrors server/src/host.ts (resolve consumes the pending
// entry; the session is checked before the approval). host.ts itself needs
// the SDK plus `muse serve`, so it stays out of tests.
function fakeHost() {
  const calls: unknown[][] = [];
  const known = new Set(["sess-1", "sess-2"]);
  const pending = new Map([
    ["appr-1", "sess-1"],
    ["appr-2", "sess-2"],
  ]);
  const needSession = (sessionId: string) => {
    if (!known.has(sessionId)) throw new UnknownSessionError(`unknown session ${sessionId}`);
  };
  const request = (approvalId: string) => ({
    approvalId,
    availableChoices: [{ choiceId: "allow-once", decision: "approved" }],
  });
  const host = {
    defaultSessionId: "sess-1",
    serverInfo: { name: "test" },
    fingerprintWarning: undefined,
    onEvent: () => () => {},
    getApprovalRequest: (sessionId: string, approvalId: string) => {
      needSession(sessionId);
      if (!pending.has(approvalId)) {
        throw new UnknownApprovalError(`approval ${approvalId} is not pending`);
      }
      return request(approvalId);
    },
    startSession: async () => "sess-2",
    sendTurn: async (sessionId: string, text: string) => {
      calls.push(["sendTurn", sessionId, text]);
      if (text === "boom") throw new Error("secret backend detail that must not leak");
      needSession(sessionId);
      return { turnId: "turn-1" };
    },
    cancelTurn: async (sessionId: string, turnId?: string) => {
      calls.push(["cancelTurn", sessionId, turnId ?? null]);
      needSession(sessionId);
      return { sessionId, turnId: turnId ?? null };
    },
    decideApproval: (sessionId: string, approvalId: string, choiceId: string) => {
      calls.push(["decideApproval", sessionId, approvalId, choiceId]);
      needSession(sessionId); // unknown session is 404, before the approval check
      const owner = pending.get(approvalId);
      if (!owner || owner !== sessionId) {
        throw new UnknownApprovalError(`approval ${approvalId} is not pending`);
      }
      pending.delete(approvalId);
    },
    answerUserInput: async (sessionId: string, userInputId: string, answers: unknown[]) => {
      calls.push(["answerUserInput", sessionId, userInputId]);
      needSession(sessionId);
      return { userInputId, status: "answered" };
    },
    history: (sessionId: string) => {
      needSession(sessionId);
      return { mode: "inline" as const, items: [] };
    },
    snapshot: (sessionId: string) => {
      needSession(sessionId);
      return { sessionId, items: [], approvals: [], userInputs: [] };
    },
    listProfiles: async () => ({ profiles: [] }),
    close: async () => {},
  };
  return { calls, host };
}

async function withServer(host: Parameters<typeof createServer>[0], fn: (base: string) => Promise<void>) {
  // Allow-stub: these tests cover routing and error shape, not the judge
  // (server/test/judge.test.ts covers that with safe/unsafe/blocked stubs).
  const server = createServer(host, { judge: async () => ({ safe: true }) });
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

describe("approval resolve consumes the pending entry", () => {
  it("a second decide on the same approval is 410 json", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const body = { sessionId: "sess-1", approvalId: "appr-1", choiceId: "allow-once" };
      assert.equal((await post(base, "/api/approval", body)).status, 200);
      const second = await post(base, "/api/approval", body);
      assert.equal(second.status, 410);
      assert.deepEqual(Object.keys(second.json as object), ["error"]);
    });
  });

  it("unknown session is 404 even for a pending approval", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const res = await post(base, "/api/approval", {
        sessionId: "nope",
        approvalId: "appr-1",
        choiceId: "allow-once",
      });
      assert.equal(res.status, 404);
      assert.deepEqual(Object.keys(res.json as object), ["error"]);
    });
  });

  it("another session's approval is 410", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const res = await post(base, "/api/approval", {
        sessionId: "sess-1",
        approvalId: "appr-2",
        choiceId: "allow-once",
      });
      assert.equal(res.status, 410);
    });
  });
});

describe("null sessionId falls back to the default session", () => {
  it("turn, cancel, approval and user-input treat null like omitted", async () => {
    const { calls, host } = fakeHost();
    await withServer(host, async (base) => {
      assert.equal((await post(base, "/api/turn", { sessionId: null, text: "hi" })).status, 200);
      assert.equal((await post(base, "/api/turn/cancel", { sessionId: null, turnId: "t1" })).status, 200);
      assert.equal(
        (await post(base, "/api/approval", { sessionId: null, approvalId: "appr-1", choiceId: "allow-once" }))
          .status,
        200,
      );
      assert.equal(
        (
          await post(base, "/api/user-input", {
            sessionId: null,
            userInputId: "q1",
            answers: [{ questionId: "a", selectedLabel: "Yes" }],
          })
        ).status,
        200,
      );
      assert.equal(calls.length, 4);
      for (const c of calls) assert.equal(c[1], "sess-1");
    });
  });
});

describe("stale sessions are 404 json", () => {
  it("cancel, history and events on unknown sessions", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const cancel = await post(base, "/api/turn/cancel", { sessionId: "nope", turnId: "t1" });
      assert.equal(cancel.status, 404);
      assert.deepEqual(Object.keys(cancel.json as object), ["error"]);

      const history = await fetch(`${base}/api/history?sessionId=nope`);
      assert.equal(history.status, 404);
      assert.deepEqual(Object.keys((await history.json()) as object), ["error"]);

      const events = await fetch(`${base}/events?sessionId=nope`);
      assert.equal(events.status, 404);
      assert.deepEqual(Object.keys((await events.json()) as object), ["error"]);
    });
  });
});

describe("error shape never leaks", () => {
  it("unexpected failures are exactly { error: 'internal error' }", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const res = await post(base, "/api/turn", { sessionId: "sess-1", text: "boom" });
      assert.equal(res.status, 500);
      assert.deepEqual(res.json, { error: "internal error" });
    });
  });

  it("long ids are capped at 300 chars", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      const stale = await post(base, "/api/approval", {
        sessionId: "sess-1",
        approvalId: "a".repeat(500),
        choiceId: "allow-once",
      });
      assert.equal(stale.status, 410);
      assert.ok((stale.json as { error: string }).error.length <= 300);

      const gone = await fetch(`${base}/api/history?sessionId=${"s".repeat(500)}`);
      assert.equal(gone.status, 404);
      assert.ok(((await gone.json()) as { error: string }).error.length <= 300);
    });
  });
});

describe("evaluate input shape", () => {
  it("bad bodies are 400 with the documented error string", async () => {
    const { host } = fakeHost();
    await withServer(host, async (base) => {
      for (const body of [
        { state: "hi", questions: {} },
        { state: "hi" },
        { questions: { u: { type: "noul", instructions: "x" } } },
      ]) {
        const res = await post(base, "/api/evaluate", body);
        assert.equal(res.status, 400);
        assert.deepEqual(res.json, { error: "state and at least one typed question are required" });
      }
    });
  });
});

describe("approveOnceChoice scope", () => {
  it("picks by decision, never by choiceId", () => {
    assert.equal(
      approveOnceChoice([
        { choiceId: "allow-once", decision: "approvedForSession" },
        { choiceId: "deny", decision: "denied" },
      ]),
      undefined,
    );
    assert.equal(
      approveOnceChoice([
        { choiceId: "allow-session", decision: "approvedForSession" },
        { choiceId: "allow-once", decision: "approved" },
      ])?.choiceId,
      "allow-once",
    );
  });
});
