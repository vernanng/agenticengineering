import {
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
  type ApprovalDecisionInput,
  type ApprovalFailure,
  type ApprovalHandler,
  type Session,
} from "@muse-code/sdk";
import { museBin, workspaceRoot } from "./config.ts";
import {
  UnknownApprovalError,
  UnknownSessionError,
  type Host,
  type UserInputAnswerInput,
} from "./server.ts";

type ApprovalRequest = Parameters<ApprovalHandler>[0];

// MSP host on the SDK facade (docs/how-it-works.html: the NODE APP box).
// The client routes every server event to its session, so the fold behind
// each session stays gap-recovered; this layer only fans out to browsers.
export async function startHost(): Promise<Host> {
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
  const client = new MuseClient(msp.connection, {
    durability: readSessionDurability(msp.initializeResult),
    host: msp,
  });
  console.log("MSP ready:", JSON.stringify(msp.initializeResult.serverInfo));
  if (msp.fingerprintWarning) console.warn("fingerprint warning:", msp.fingerprintWarning.message);

  // shortcut: sessions are never closed or evicted, so this map only grows. Fine for one
  // local user (tens of sessions); the SDK has no per-session close, only client.close().
  // Upgrade to a cap plus a close endpoint when many sessions become normal.
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, { sessionId: string; resolve: (d: ApprovalDecisionInput) => void }>();
  const subscribers = new Set<(event: string, data: unknown) => void>();
  const emit = (event: string, data: unknown) => {
    for (const send of subscribers) send(event, data);
  };

  // Raw fan-out for the browser; the client's own router already folded first.
  msp.connection.onNotification((notification) => {
    if (notification.method === "approval/resolved") {
      const id = (notification.params as { approvalId?: unknown }).approvalId;
      if (typeof id === "string") approvals.delete(id); // dangling handler promises stay the router's to drop
    }
    emit("msp", { method: notification.method, params: notification.params });
  });

  function needSession(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (!session) throw new UnknownSessionError(`unknown session ${sessionId}`);
    return session;
  }

  // The permission profile applies at session start (select, never create);
  // switching modes starts a new session.
  async function startSession(profile?: string | null): Promise<string> {
    const session = await client.startSession(
      profile ? { workspaceRoot, permissionProfile: profile } : { workspaceRoot },
    );
    // Park the browser's decision: the facade checks the choice against the
    // server's current offer and reports a bad one via onApprovalError.
    session.onApproval(
      (request: ApprovalRequest) =>
        new Promise<ApprovalDecisionInput>((resolve) => {
          approvals.set(request.approvalId, { sessionId: session.sessionId, resolve });
        }),
    );
    session.onApprovalError((failure: ApprovalFailure) => {
      console.error("approval failed:", failure.approvalId, failure.kind);
      emit("msp", { method: "approval/failed", params: { sessionId: session.sessionId, ...failure } });
    });
    sessions.set(session.sessionId, session);
    return session.sessionId;
  }

  const defaultSessionId = await startSession();
  console.log("session:", defaultSessionId);

  return {
    defaultSessionId,
    serverInfo: msp.initializeResult.serverInfo,
    fingerprintWarning: msp.fingerprintWarning?.message,

    onEvent: (sub) => {
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },

    startSession,

    async sendTurn(sessionId: string, text: string) {
      const turn = await needSession(sessionId).sendUserTurn({ input: [{ type: "text", text }] });
      // The ack only admits the turn; forward its server-authored outcome too,
      // so a terminal the broadcast never carries (unqueued, host death) still
      // reaches the browser as turn/ended.
      void turn.completed.then(
        (outcome) =>
          emit("msp", {
            method: "turn/ended",
            params: {
              sessionId,
              turnId: turn.turnId,
              outcome: outcome.kind,
              terminal: outcome.kind === "completed" ? outcome.params.terminal : outcome.kind,
            },
          }),
        () =>
          emit("msp", {
            method: "turn/ended",
            params: { sessionId, turnId: turn.turnId, outcome: "rejected" },
          }),
      );
      return { turnId: turn.turnId };
    },

    cancelTurn(sessionId: string, turnId?: string) {
      needSession(sessionId);
      return msp.connection.command("turn/cancel", turnId ? { sessionId, turnId } : { sessionId });
    },

    decideApproval(sessionId: string, approvalId: string, choiceId: string) {
      needSession(sessionId); // unknown session is 404, before the approval check below
      const waiter = approvals.get(approvalId);
      if (!waiter || waiter.sessionId !== sessionId) {
        throw new UnknownApprovalError(`approval ${approvalId} is not pending`);
      }
      approvals.delete(approvalId);
      waiter.resolve({ choiceId });
    },

    answerUserInput(sessionId: string, userInputId: string, answers: UserInputAnswerInput[]) {
      return needSession(sessionId).answerUserInput(userInputId, answers);
    },

    history(sessionId: string) {
      return { mode: "inline" as const, items: needSession(sessionId).fold.items.list() };
    },

    snapshot(sessionId: string) {
      const session = needSession(sessionId);
      return {
        sessionId,
        items: session.fold.items.list(),
        approvals: session.fold.pendingApprovals().map((p) => p.requested),
        userInputs: session.fold.pendingUserInputs(),
      };
    },

    listProfiles() {
      return msp.connection.command("permissionProfile/list", {});
    },

    close: () => client.close(),
  };
}
