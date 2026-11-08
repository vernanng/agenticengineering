// TypeSafe System One proxy: POST to the TYPESAFE_BASE_URL endpoint with a Bearer key.
// Raw fetch, no SDK: the request/response shapes already match the API,
// so a dependency would only rename fields.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

// Fall back to the checkout's .env when vars aren't already set, so this works
// whether or not node was started with --env-file. Never overrides the environment.
const DOTENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
if (fs.existsSync(DOTENV)) {
  for (const line of fs.readFileSync(DOTENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    const v = m[2];
    process.env[m[1]] =
      v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'") ? v.slice(1, -1) : v;
  }
}

// No "box": the client cannot upload images yet, so a box question could
// never be answered (see JudgePage). Re-add it with the upload.
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function validEvaluateBody(body: unknown): body is {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
} {
  if (!body || typeof body !== "object") return false;
  const { state, questions, model } = body as Record<string, unknown>;
  if (typeof state === "string" ? !state.trim() : state === null || state === undefined) return false;
  if (typeof state !== "string" && typeof state !== "object") return false;
  if (typeof state === "string" && state.length > 100_000) return false;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return false;
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > 32) return false;
  if (model !== undefined && (typeof model !== "string" || model.length === 0 || model.length > 128))
    return false;
  return entries.every(([name, q]) => {
    if (!name || !q || typeof q !== "object" || Array.isArray(q)) return false;
    const { type, instructions, criteria } = q as Record<string, unknown>;
    if (
      !QUESTION_TYPES.has(type as string) ||
      typeof instructions !== "string" ||
      instructions.trim() === "" ||
      instructions.length > 8000
    )
      return false;
    // Shape per question type (see the TypeSafe quickstart): a choice needs
    // its option map and a score its level list, or the upstream call fails after a 200.
    if (type === "choice")
      return !!criteria && typeof criteria === "object" && !Array.isArray(criteria) && Object.keys(criteria).length > 0;
    if (type === "score") return Array.isArray(criteria) && criteria.length >= 2;
    return true;
  });
}

export async function evaluate(state: unknown, questions: unknown, model?: string) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) fail(500, "TYPESAFE_API_KEY is not set");
  const endpoint = (process.env.TYPESAFE_BASE_URL || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const resolvedModel = model || process.env.TYPESAFE_MODEL || DEFAULT_MODEL;
  const payload = JSON.stringify({ model: resolvedModel, state, questions });
  if (payload.length > 1_000_000) fail(400, "request too large");
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(502, "evaluation failed");
  }
  const data = (await res.json().catch(() => ({}))) as { detail?: unknown };
  if (!res.ok) fail(502, "evaluation failed");
  return data as { model: string; answers: Record<string, unknown>; usage: unknown };
}
