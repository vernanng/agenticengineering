import { spawnMspConnection } from "@muse-code/sdk";
import { museBin, workspaceRoot } from "./config.ts";

export type Subscriber = (event: string, data: unknown) => void;

export interface ChatHost {
  msp: Awaited<ReturnType<ReturnType<typeof spawnMspConnection>["initialize"]>>;
  subscribers: Set<Subscriber>;
  defaultSessionId: string;
  startSession: (profile?: string | null) => Promise<string>;
}

// MSP host (quickstart steps 1-3: spawn, handshake, first session).
// The permission profile applies at session start (select, never create);
// switching modes starts a new session.
export async function startHost(): Promise<ChatHost> {
  const handshake = spawnMspConnection({
    command: museBin,
    args: ["serve"],
    cwd: workspaceRoot,
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  const msp = await handshake.initialize({
    clientInfo: { name: "muse_chat", version: "1.0.0" },
    capabilities: { experimentalApi: true }, // permission profiles live behind this
  });
  console.log("MSP ready:", JSON.stringify(msp.initializeResult.serverInfo));
  if (msp.fingerprintWarning) console.warn("fingerprint warning:", msp.fingerprintWarning);

  // Fan-out for MSP notifications (quickstart step 4: the answer arrives as notifications).
  const subscribers = new Set<Subscriber>();
  msp.connection.onNotification((notification) => {
    const event = { method: notification.method, params: notification.params };
    for (const send of subscribers) send("msp", event);
  });

  async function startSession(profile?: string | null): Promise<string> {
    const params: Record<string, unknown> = { workspaceRoot };
    if (profile) params.permissionProfile = profile;
    const result = await msp.connection.command("session/start", params);
    return (result.session as { sessionId: string }).sessionId;
  }

  const host: ChatHost = {
    msp,
    subscribers,
    defaultSessionId: await startSession(),
    startSession,
  };
  console.log("session:", host.defaultSessionId);
  return host;
}
