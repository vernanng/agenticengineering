# AGENTS.md

## Working style

- Follow ASD-STE100 about 80% of the way.

See [README.md](./README.md) for the project overview, commands, and layout.

## Frontend changes via chat

Any website change is in scope: reshaping, sections, pages, and features.
- Reshape: edit [shape.ts](./client/src/shape.ts) (`layout`, `showStats`, `showTraffic`) or move a panel tag in [App.svelte](./client/src/App.svelte).
- Section: new `client/src/components/*.svelte` taking `{ chat }`, tag it in App.svelte. Remove: delete its tag.
- LWC element: new `client/src/modules/<ns>/<name>/` (`name.js` + `name.html`), mount it from a Svelte host with `createElement` (see `LwcHello.svelte`).
- Page: real URL routes. Add a router, register the route, and fall back to `index.html` for unknown non-`/api` paths in `server/src/server.ts` (it 404s them today).
- Feature: full stack when needed. New endpoint in `server/src/server.ts` with a JSON error shape, store logic in `client/src/lib/`, tests in `server/test/`.
- After the edit run `npm run build:client` and `npm test`. The user reloads the page.
- Commit only the files the change touched, one commit per request, then report what changed, including any new dependency.

## Conventions

- Use ESM `import`/`export` syntax throughout.
- Keep explicit `.ts` extensions on relative imports.
- Name test files `*.test.ts` with `describe`/`it` from `node:test`.
- Fake the `Host` seam in tests (see `server/test/server.test.ts`); never spawn `muse serve` in tests.
- Keep `@lwc/rollup-plugin` scoped to `src/modules` in `client/vite.config.ts`; LWC owns its CSS, `vite:css` stays off that dir.
- Every API route returns JSON errors: 404 unknown session, 410 stale approval, 400 bad input.
