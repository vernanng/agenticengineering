# AGENTS.md

## Working style

- Follow ASD-STE100 about 80% of the way.

See [README.md](./README.md) for the project overview, commands, and layout.

## Conventions

- Use ESM `import`/`export` syntax throughout.
- Keep explicit `.ts` extensions on relative imports.
- Name test files `*.test.ts` with `describe`/`it` from `node:test`.
- Fake the `Host` seam in tests (see `test/server.test.ts`); never spawn `muse serve` in tests.
- Every API route returns JSON errors: 404 unknown session, 410 stale approval, 400 bad input.
