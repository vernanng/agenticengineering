# Plan: JEV as server-side approval judge (fail-closed)

## Goal
Every `POST /api/approval` is judged by TypeSafe JEV before the choice reaches
the SDK. Unsafe, unjudgeable, or timed-out calls never resolve. This moves the
bypassable browser-only authorizer (`judgeApproval` in the client) into the hub
where it cannot be skipped.

## Non-goals
- Turn-transcript scoring. Approvals only.
- Session identity / caller auth. Still deferred: anyone reaching the port is
  judged on the safety of the call itself, not on who they are.
- Changing the client auto-approve loop. It stays as a first pass; the server
  is the enforcement point.

## Flow
1. `POST /api/approval` validates shape (as today), checks session (404) and
   pending approval (410) as today.
2. New step: build judge state with `approvalTitle` + truncated `rawArgs`
   (same 2000-char cut the client uses), ask one `noul` question —
   "This tool call is safe to approve without human review".
3. `score >= 0.9` with a well-formed answer → resolve to the SDK (today's
   `decideApproval` path) and return the choice.
4. Anything else (low score, malformed answer, timeout, upstream error,
   missing key) → do NOT resolve; return `403 { error: "rejected by judge" }`.
   The pending approval stays parked for a human decision.

## Design points
- Timeout 15s on the judge fetch (matches `typesafe.ts` abort); judge failure
  is a rejection, never a pass. `shortcut: raise the timeout before the
  threshold if slow models cause human-visible stalls.`
- Keep the narrow-scope rule: only `decision === "approved"` with
  `scope === undefined | "once"` is even eligible for judging; anything else
  is rejected without spending a JEV call.
- Testability: `createServer(host, opts?: { judge?: JudgeFn })`, defaulting to
  the real JEV `evaluate`. Tests inject a stub (same fake-seam pattern as the
  `Host` fake in `server/test/regression.test.ts`); no `muse serve`, no
  network in tests.
- Shared logic: move `approvalTitle` / state-text / `SAFETY_QUESTION` /
  threshold into a server-importable module (e.g. `server/src/judge.ts`) so
  server and client judge identically; update `safety.test.ts` imports.
- Cost: one JEV call per approval, human clicks included. Exempting the human
  path would leave the bypass open (auto and human share `POST /api/approval`,
  indistinguishable server-side), so every approval is judged. Decided during
  implementation.

## Files to touch
- New `server/src/judge.ts` (pure, testable).
- `server/src/server.ts` (`POST /api/approval` + 403 shape).
- `client/src/lib/safety.ts` (import shared logic; behavior unchanged).
- `server/test/judge.test.ts` (new: judge unit + gated-route tests),
  `server/test/server.test.ts` + `regression.test.ts` (allow-stub judge;
  they cover routing, not judging), `server/test/typesafe.test.ts` (stub).
- `docs/client-server-architecture.html`: add the EVAL edge into the approval
  path once implemented.

## Verification
- `npm test` (new judge tests + full suite), `npm run build:client`.
- Probe: unsafe fixture → 403 and approval still pending; safe fixture →
  resolves; key missing → 403, nothing resolves (fail-closed proof).

## Risks
- Without the key set, ALL approvals block. Fail-closed is the point, but
  local dev without `TYPESAFE_API_KEY` loses approvals (judge throws →
  403). Acceptable: no silent auto-run without a judge.
- Added latency per approval (up to the 15s cap on slow days).
- No caller identity means the judge scores the call, not the caller.
