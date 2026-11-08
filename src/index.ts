import { PORT } from "./config.ts";
import { startHost } from "./host.ts";
import { createServer } from "./server.ts";

const host = await startHost();
const server = createServer(host);

server.listen(PORT, () => {
  console.log(`chat: http://localhost:${PORT}`);
});

// Quickstart step 7: clean shutdown drains the host and releases the session lease.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await host.msp.close();
    process.exit(0);
  });
}
