# agenticengineering

Browser chat over a Node bridge to Muse via `@muse-code/sdk` (MSP).
The server is the hub: `POST /api/turn` starts a turn, `/events` streams the
answer back over SSE, `POST /api/turn/cancel` stops it. Config comes only
from `.env` (`PORT`, `museBin`, `workspaceRoot`); nothing is defaulted.

## Commands

- `npm run dev` — start the project (watch mode).
- `npm start` — start the project.
- `npm test` — run the full test suite.

## Code Map

- `src/` — application source (`index.ts`, `config.ts`, `host.ts`, `server.ts`).
- `test/` — automated tests.
- `public/` — browser chat client.
