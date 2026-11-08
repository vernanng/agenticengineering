import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, UnknownApprovalError, UnknownSessionError } from "../src/server.ts";
import { judgeApproval } from "../src/judge.ts";

// Fake Host seam: mirrors server/src/host.ts (requests are parked at offer
// time; the session is checked before the approval). host.ts itself needs
// the SDK plus `muse serve`, so it stays out of tests.
function fakeHost() {
  const calls: unknown[][] = [];
  const known = new Set(["sess-1"]);
  const pending = new Map([
    [
      "appr-1",
      {
        approvalId: "appr-1",
        subject: { title: "rm -rf /" },
        rawArgs: "--no-preserve-root",
        availableChoices: [{ choiceId: "allow-once", decision: "approved" }],
      },
    ],
    [
      "appr-2",
      {
        approvalId: "appr-2",
        subject: { title: "read .env" },
        availableChoices: [{ choiceId: "allow-session", decision: "approved", scope: "session" }],
      },
    ],
  ]);
  const needSession = (sessionId: string) => {
    if (!known.has(sessionId)) throw new UnknownSessionError(`unknown session ${sessionId}`);
  };
  const host = {
    defaultSessionId: "sess-1",
    serverInfo: { name: "test" },
    fingerprintWarning: undefined,
    onEvent: () => () => {},
    startSession: async () => "sess-1",
    sendTurn: async () => ({ turnId: "turn-1" }),
    cancelTurn: async () => ({}),
    getApprovalRequest: (sessionId: string, approvalId: string) => {
      needSession(sessionId);
      const request = pending.get(approvalId);
      if (!request) throw new UnknownApprovalError(`approval ${approvalId} is not pending`);
      return request;
    },
    decideApproval: (sessionId: string, approvalId: string, choiceId: string) => {
      calls.push(["decideApproval", sessionId, approvalId, choiceId]);
      needSession(sessionId);
      if (!pending.delete(approvalId)) {
        throw new UnknownApprovalError(`approval ${approvalId} is not pending`);
      }
    },
    answerUserInput: async () => ({}),
    history: () => ({ mode: "inline" as const, items: [] }),
    snapshot: () => ({ sessionId: "sess-1", items: [], approvals: [], userInputs: [] }),
    listProfiles: async () => ({ profiles: [] }),
    close: async () => {},
  };
  return { calls, host };
}

type JudgeStub = (request: unknown) => Promise<{ safe: boolean } | null>;

async function withServer(
  host: Parameters<typeof createServer>[0],
  judge: JudgeStub,
  fn: (base: string) => Promise<void>,
) {
  const server = createServer(host, { judge: judge as never });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

async function post(base: string, body: unknown) {
  const res = await fetch(base + "/api/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "sess-1", ...body }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

describe("judgeApproval", () => {
  const request = { approvalId: "a", subject: { title: "t" } };
  it("passes a clear safe vote", async () => {
    const v = await judgeApproval(async () => ({ answers: { safe: { type: "noul", noul: 0.99 } } }), request);
    assert.deepEqual(v, { safe: true, noul: 0.99 });
  });

  it("fails closed on low, malformed, and throwing votes", async () => {
    assert.deepEqual(
      await judgeApproval(async () => ({ answers: { safe: { type: "noul", noul: 0.1 } } }), request),
      { safe: false, noul: 0.1 },
    );
    assert.equal(await judgeApproval(async () => ({ answers: {} }), request), null);
    assert.equal(
      await judgeApproval(async () => {
        throw new Error("upstream down");
      }, request),
      null,
    );
  });

  it("fails closed on timeout", async () => {
    assert.equal(await judgeApproval(() => new Promise(() => {}), request, 5), null);
  });
});

describe("gated /api/approval", () => {
  it("safe vote resolves, unsafe vote is 403 and stays pending", async () => {
    const { calls, host } = fakeHost();
    await withServer(host, async () => ({ safe: true }), async (base) => {
      const ok = await post(base, { approvalId: "appr-1", choiceId: "allow-once" });
      assert.equal(ok.status, 200);
    });
    assert.deepEqual(calls, [["decideApproval", "sess-1", "appr-1", "allow-once"]]);

    const again = fakeHost();
    await withServer(again.host, async () => ({ safe: false }), async (base) => {
      const denied = await post(base, { approvalId: "appr-1", choiceId: "allow-once" });
      assert.equal(denied.status, 403);
      assert.deepEqual(denied.json, { error: "rejected by judge" });
      const retry = await post(base, { approvalId: "appr-1", choiceId: "allow-once" });
      assert.equal(retry.status, 403);
    });
    assert.equal(again.calls.length, 0);
  });

  it("broad-scope grants are 403 without spending a judge call", async () => {
    let judged = 0;
    const { calls, host } = fakeHost();
    await withServer(
      host,
      async () => {
        judged++;
        return { safe: true };
      },
      async (base) => {
        const res = await post(base, { approvalId: "appr-2", choiceId: "allow-session" });
        assert.equal(res.status, 403);
        assert.deepEqual(res.json, { error: "rejected by judge" });
      },
    );
    assert.equal(judged, 0);
    assert.equal(calls.length, 0);
  });
});
