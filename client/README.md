# client

Browser chat client: Svelte 5 + Vite, with Lightning Web Components
([LWC](https://lwc.dev)) for embeddable elements. Built to `dist/` and served
by the hub. Shared state lives in `src/lib/chat.svelte.ts`.

## Commands (from the repo root)

- `npm run dev:client` — dev server with HMR.
- `npm run build:client` — production build to `dist/`.

## Add UI

- Svelte section: new `src/components/*.svelte`, tag it in `src/App.svelte`.
- LWC element: new `src/modules/<ns>/<name>/` with `name.js` + `name.html`
  (optional `name.css` / `name.scoped.css`). Mount it from a Svelte host with
  `createElement` from `lwc`; see `src/components/LwcHello.svelte`.

## Notes

- `@lwc/rollup-plugin` in `vite.config.ts` is scoped to `src/modules`.
  Bare `.html` imports get a `?lwc` query so Vite keeps them as JS modules;
  `vite:css` skips that dir because LWC compiles its own CSS.
- LWC sources are JS, so TS callers import them with `// @ts-ignore`.
