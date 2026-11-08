import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFileDurable,
  createMemoryDurable,
  durableHistoryItems,
  StorageRequestError,
} from "../src/durable.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "durable-test-"));
}

describe("durable log", () => {
  it("admits a turn and settles it done with an outcome record", () => {
    const store = createMemoryDurable();
    const admitted = store.append("sess-1", "user", "hi");
    assert.equal(admitted.status, "pending");
    assert.equal(admitted.turnId, null);
    assert.deepEqual(store.pendingTurns("sess-1").map((e) => e.entryId), [admitted.entryId]);

    store.attachTurn(admitted.entryId, "turn-1");
    store.settleTurn("turn-1", "done", "turn completed");

    assert.deepEqual(store.pendingTurns("sess-1"), []);
    const kinds = store.list("sess-1").map((e) => [e.kind, e.status]);
    assert.deepEqual(kinds, [
      ["user", "done"],
      ["outcome", "done"],
    ]);
  });

  it("fails the admission when the turn never reaches the SDK", () => {
    const store = createMemoryDurable();
    const admitted = store.append("sess-1", "user", "boom");
    store.failEntry(admitted.entryId);
    assert.deepEqual(
      store.list("sess-1").map((e) => [e.kind, e.status]),
      [["user", "failed"]],
    );
  });

  it("marks pending turns failed on reopen and ignores stale completions", () => {
    const store = createMemoryDurable();
    const admitted = store.append("sess-1", "user", "dies mid-flight");
    store.attachTurn(admitted.entryId, "turn-9");
    store.reopen();
    assert.deepEqual(
      store.list("sess-1").map((e) => [e.kind, e.status]),
      [["user", "failed"]],
    );
    store.settleTurn("turn-9", "done", "turn completed");
    assert.deepEqual(
      store.list("sess-1").map((e) => [e.kind, e.status]),
      [["user", "failed"]],
    );
  });

  it("persists across instances and fails what was pending at reopen", () => {
    const dir = tmpDir();
    const first = createFileDurable(dir);
    const done = first.append("sess-1", "user", "saved");
    first.attachTurn(done.entryId, "turn-1");
    first.settleTurn("turn-1", "done", "turn completed");
    const pending = first.append("sess-1", "user", "interrupted");
    first.attachTurn(pending.entryId, "turn-2");
    first.close();

    const second = createFileDurable(dir);
    try {
      assert.deepEqual(second.sessions(), ["sess-1"]);
      assert.deepEqual(
        second.list("sess-1").map((e) => [e.kind, e.status, e.turnId]),
        [
          ["user", "done", "turn-1"],
          ["outcome", "done", "turn-1"],
          ["user", "failed", "turn-2"],
        ],
      );
      assert.deepEqual(second.pendingTurns("sess-1"), []);
    } finally {
      second.close();
    }
  });

  it("replays dead sessions as fold-shaped history items", () => {
    const store = createMemoryDurable();
    store.append("sess-1", "user", "hello");
    const items = durableHistoryItems("sess-1", store);
    assert.deepEqual(items, [{ itemId: items[0].itemId, kind: "userMessage", text: "hello" }]);
    assert.deepEqual(durableHistoryItems("nope", store), []);
  });

  it("reports an unusable directory as a json error, not a crash", () => {
    const blocker = path.join(tmpDir(), "blocker");
    fs.writeFileSync(blocker, "in the way");
    assert.throws(() => createFileDurable(blocker), StorageRequestError);
  });
});
