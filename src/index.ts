import { PORT } from "./config.ts";
import { startHost } from "./host.ts";
import { createServer } from "./server.ts";

const host = await startHost();
const server = createServer(host);

await server.listen({ port: PORT });
console.log(`chat: http://localhost:${PORT}`);

// Clean shutdown drains the host and releases the session lease.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    await host.close();
    process.exit(0);
  });
}
