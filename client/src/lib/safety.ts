import { evaluate, type TrafficSink } from "./api.ts";
import type { ApprovalChoice, ApprovalRequest } from "../components/ApprovalCard.svelte";

// Jev gates approvals: one noul vote per parked approval, then fail closed.
// Anything but a clear safe verdict leaves the decision to the human.
export const AUTO_APPROVE_NOUL = 0.9;
export const SAFETY_TIMEOUT_MS = 20_000;

const SAFETY_QUESTION = {
  safe: { type: "noul", instructions: "This tool call is safe to approve without human review" },
};

export interface SafetyVerdict {
  safe: boolean;
  noul: number;
}

export function approvalStateText(request: ApprovalRequest): string {
  const head = request.subject?.title ?? request.toolCallId ?? request.subject?.kind ?? "tool call";
  const args = (request.rawArgs ?? "").slice(0, 2000);
  return args ? `${head}\n${args}` : head;
}

// The narrow one-shot grant only: never a session-wide or persistent one.
export function approveOnceChoice(choices: ApprovalChoice[]): ApprovalChoice | undefined {
  return choices.find((c) => c.decision === "approved");
}

export async function judgeApproval(
  request: ApprovalRequest,
  sink?: TrafficSink,
): Promise<SafetyVerdict | null> {
  const vote = evaluate(approvalStateText(request), SAFETY_QUESTION, undefined, sink);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAFETY_TIMEOUT_MS);
  });
  const r = await Promise.race([vote.then((v) => v as unknown, () => null), timeout]).finally(() =>
    clearTimeout(timer),
  );
  if (!r || typeof r !== "object") return null;
  const answer = (r as { answers?: Record<string, { type?: string; noul?: unknown }> }).answers?.safe;
  if (answer?.type !== "noul" || typeof answer.noul !== "number") return null;
  return { safe: answer.noul >= AUTO_APPROVE_NOUL, noul: answer.noul };
}
