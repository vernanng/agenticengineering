import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_APPROVE_NOUL,
  approvalStateText,
  approveOnceChoice,
  judgeApproval,
} from "../../client/src/lib/safety.ts";

const realFetch = globalThis.fetch;
let canned = { ok: true, status: 200, body: {} as unknown };

beforeEach(() => {
  canned = { ok: true, status: 200, body: { answers: { safe: { type: "noul", noul: 0.95 } } } };
  globalThis.fetch = (async () => ({
    ok: canned.ok,
    status: canned.status,
    json: async () => canned.body,
  })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = (over: Record<string, unknown> = {}) => ({
  approvalId: "appr-1",
  subject: { title: "rm -rf /tmp/x" },
  rawArgs: "--force",
  ...over,
});

describe("safety gate", () => {
  it("picks only the narrow one-shot grant", () => {
    const choices = [
      { choiceId: "deny", decision: "denied", scope: "once" },
      { choiceId: "allow-session", decision: "approvedForSession", scope: "session" },
      { choiceId: "allow-once", decision: "approved", scope: "once" },
    ];
    assert.equal(approveOnceChoice(choices)?.choiceId, "allow-once");
    assert.equal(approveOnceChoice(choices.slice(0, 2)), undefined);
    // An "approved" decision with a wider grant is not one-shot.
    assert.equal(
      approveOnceChoice([{ choiceId: "allow-wide", decision: "approved", scope: "session" }]),
      undefined,
    );
    assert.equal(approveOnceChoice([]), undefined);
  });

  it("states the call with its title and args", () => {
    const text = approvalStateText(request());
    assert.match(text, /rm -rf \/tmp\/x/);
    assert.match(text, /--force/);
  });

  it(`auto-passes at noul >= ${AUTO_APPROVE_NOUL}, holds below`, async () => {
    assert.deepEqual(await judgeApproval(request()), { safe: true, noul: 0.95 });
    canned.body = { answers: { safe: { type: "noul", noul: 0.5 } } };
    assert.deepEqual(await judgeApproval(request()), { safe: false, noul: 0.5 });
  });

  it("fails closed on upstream errors and malformed answers", async () => {
    canned = { ok: false, status: 502, body: { error: "nope" } };
    assert.equal(await judgeApproval(request()), null);
    canned = { ok: true, status: 200, body: { answers: { safe: { type: "choice", choice: "x" } } } };
    assert.equal(await judgeApproval(request()), null);
  });
});
