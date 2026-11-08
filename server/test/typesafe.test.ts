import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";

const stubHost = {
  defaultSessionId: "sess-1",
  serverInfo: { name: "test" },
  fingerprintWarning: undefined,
  onEvent: () => () => {},
  startSession: async () => "sess-2",
  sendTurn: async () => ({ turnId: "turn-1" }),
  cancelTurn: async () => ({}),
  decideApproval: () => {},
  getApprovalRequest: () => ({ approvalId: "appr-1", availableChoices: [] }),
  answerUserInput: async () => ({}),
  history: () => ({ mode: "inline" as const, items: [] }),
  snapshot: () => ({ sessionId: "sess-1", items: [], approvals: [], userInputs: [] }),
  listProfiles: async () => ({ profiles: [] }),
  close: async () => {},
};

async function withServer(fn: (base: string) => Promise<void>) {
  const server = createServer(stubHost);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

async function post(base: string, body: unknown) {
  const res = await fetch(base + "/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

const realFetch = globalThis.fetch;
const seen: { url: unknown; init: RequestInit | undefined }[] = [];
let canned = { ok: true, status: 200, body: {} as unknown };
let savedKey: string | undefined;
let savedBase: string | undefined;
let savedModel: string | undefined;

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  savedBase = process.env.TYPESAFE_BASE_URL;
  savedModel = process.env.TYPESAFE_MODEL;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_BASE_URL = "https://typesafe.test/v1/systemone";
  delete process.env.TYPESAFE_MODEL;
  seen.length = 0;
  canned = {
    ok: true,
    status: 200,
    body: { model: "jev-1", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: {} },
  };
  globalThis.fetch = ((url: unknown, init: RequestInit | undefined) => {
    if (!String(url).includes("typesafe")) return realFetch(url as string, init);
    seen.push({ url, init });
    return Promise.resolve({ ok: canned.ok, status: canned.status, json: async () => canned.body });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.TYPESAFE_BASE_URL;
  else process.env.TYPESAFE_BASE_URL = savedBase;
  if (savedModel === undefined) delete process.env.TYPESAFE_MODEL;
  else process.env.TYPESAFE_MODEL = savedModel;
});

describe("POST /api/evaluate", () => {
  it("forwards to TypeSafe with the key and returns answers", async () => {
    await withServer(async (base) => {
      const body = {
        state: "the servers are down",
        questions: { urgent: { type: "noul", instructions: "is this urgent?" } },
      };
      const { status, json } = await post(base, body);
      assert.equal(status, 200);
      assert.deepEqual(json, canned.body);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "https://typesafe.test/v1/systemone");
      assert.equal((seen[0].init?.headers as Record<string, string>).Authorization, "Bearer test-key");
      assert.deepEqual(JSON.parse(seen[0].init?.body as string), { model: "jev-latest", ...body });
    });
  });

  it("defaults to TYPESAFE_MODEL, body model wins", async () => {
    process.env.TYPESAFE_MODEL = "jev-preview";
    await withServer(async (base) => {
      const q = { urgent: { type: "noul", instructions: "is this urgent?" } };
      assert.equal((await post(base, { state: "hi", questions: q })).status, 200);
      assert.equal(JSON.parse(seen[0].init?.body as string).model, "jev-preview");
      assert.equal((await post(base, { state: "hi", model: "jev-other", questions: q })).status, 200);
      assert.equal(JSON.parse(seen[1].init?.body as string).model, "jev-other");
    });
  });

  it("uses the documented endpoint when no base is set", async () => {
    delete process.env.TYPESAFE_BASE_URL;
    await withServer(async (base) => {
      const { status } = await post(base, {
        state: "hi",
        questions: { urgent: { type: "noul", instructions: "is this urgent?" } },
      });
      assert.equal(status, 200);
      assert.equal(seen[0].url, "https://api.typesafe.ai/v1/systemone");
    });
  });

  it("honors an explicit model", async () => {
    await withServer(async (base) => {
      const { status } = await post(base, {
        state: "hi",
        model: "jev-preview",
        questions: { urgent: { type: "noul", instructions: "is this urgent?" } },
      });
      assert.equal(status, 200);
      assert.equal(JSON.parse(seen[0].init?.body as string).model, "jev-preview");
    });
  });

  it("rejects missing state, empty questions, and untyped questions", async () => {
    await withServer(async (base) => {
      const q = { urgent: { type: "noul", instructions: "is this urgent?" } };
      assert.equal((await post(base, { questions: q })).status, 400);
      assert.equal((await post(base, { state: "  ", questions: q })).status, 400);
      assert.equal((await post(base, { state: "hi", questions: {} })).status, 400);
      assert.equal((await post(base, { state: "hi", questions: { u: { type: "vibe" } } })).status, 400);
      assert.equal(seen.length, 0);
    });
  });

  it("rejects box questions the client cannot send", async () => {
    await withServer(async (base) => {
      const { status } = await post(base, {
        state: "hi",
        questions: { area: { type: "box", instructions: "point at it" } },
      });
      assert.equal(status, 400);
      assert.equal(seen.length, 0);
    });
  });

  it("reports a missing key as json, not a crash", async () => {
    delete process.env.TYPESAFE_API_KEY;
    await withServer(async (base) => {
      const { status, json } = await post(base, {
        state: "hi",
        questions: { urgent: { type: "noul", instructions: "is this urgent?" } },
      });
      assert.equal(status, 500);
      assert.deepEqual(json, { error: "evaluation failed" });
    });
  });

  it("passes upstream failures through as 502", async () => {
    canned = { ok: false, status: 400, body: { detail: "bad questions" } };
    await withServer(async (base) => {
      const { status, json } = await post(base, {
        state: "hi",
        questions: { urgent: { type: "noul", instructions: "is this urgent?" } },
      });
      assert.equal(status, 502);
      assert.deepEqual(json, { error: "evaluation failed" });
    });
  });
});
