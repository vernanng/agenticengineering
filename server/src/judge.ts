// Server-side JEV judge: every approval is judged before it reaches the SDK.
// Fail-closed: anything but a clear safe vote rejects, and rejections never
// resolve. Tests pass a stub evaluate; production passes the real TypeSafe
// evaluate. Pure inputs come from client/src/lib/safety.ts (same question,
// same threshold, same timeout the browser uses for its first pass).
import type { ApprovalRequest } from "../../client/src/components/ApprovalCard.svelte";
import {
  approvalStateText,
  AUTO_APPROVE_NOUL,
  SAFETY_TIMEOUT_MS,
} from "../../client/src/lib/safety.ts";
import { evaluate } from "./typesafe.ts";

const SAFETY_QUESTION = {
  safe: { type: "noul", instructions: "This tool call is safe to approve without human review" },
};

export interface JudgeVerdict {
  safe: boolean;
  noul?: number;
}

export type EvaluateFn = (state: unknown, questions: unknown, model?: string) => Promise<unknown>;
export type JudgeFn = (request: ApprovalRequest) => Promise<JudgeVerdict | null>;

// Narrow one-shot grants only: a broad persistent grant never reaches the
// judge, so no JEV call is spent on it.
export function isEligible(request: ApprovalRequest, choiceId: string): boolean {
  const scope = request.availableChoices?.find((c) => c.choiceId === choiceId)?.scope;
  return scope === undefined || scope === "once";
}

export async function judgeApproval(
  evaluateFn: EvaluateFn,
  request: ApprovalRequest,
  timeoutMs = SAFETY_TIMEOUT_MS,
): Promise<JudgeVerdict | null> {
  const vote = evaluateFn(approvalStateText(request), SAFETY_QUESTION);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const r = await Promise.race([vote.then((v) => v as unknown, () => null), timeout]).finally(() =>
    clearTimeout(timer),
  );
  if (!r || typeof r !== "object") return null;
  const answer = (r as { answers?: Record<string, { type?: string; noul?: unknown }> }).answers?.safe;
  if (answer?.type !== "noul" || typeof answer.noul !== "number") return null;
  return { safe: answer.noul >= AUTO_APPROVE_NOUL, noul: answer.noul };
}

// Production judge: the real TypeSafe evaluate with the client timeout.
export const jevJudge: JudgeFn = (request) => judgeApproval(evaluate, request);
