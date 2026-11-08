export type TrafficSink = (dir: "in" | "out", label: string, data: unknown) => void;

// Generic item text: agent/user text, tool call args, or a compact fallback.
export function itemText(item: unknown): string {
  if (!item || typeof item !== "object") return String(item ?? "");
  const o = item as Record<string, unknown>;
  if (typeof o.text === "string" && o.text) return o.text;
  if (typeof o.output === "string" && o.output) return o.output;
  if (typeof o.fallbackText === "string" && o.fallbackText) return o.fallbackText;
  const details =
    typeof o.toolName === "string" ? `${o.toolName} ${o.rawArgs ?? ""}` : JSON.stringify(item);
  return details.length > 500 ? details.slice(0, 500) + "…" : details;
}

// TypeSafe System One via the hub (key stays server-side).
export async function evaluate(
  state: unknown,
  questions: Record<string, unknown>,
  model?: string,
  sink?: TrafficSink,
): Promise<{ model: string; answers: Record<string, unknown>; usage: unknown }> {
  return apiPost(
    "/api/evaluate",
    { state, questions, model },
    sink,
  ) as Promise<{ model: string; answers: Record<string, unknown>; usage: unknown }>;
}

export function apiPost(path: string, body: unknown, sink?: TrafficSink): Promise<unknown> {
  return api(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    sink,
  );
}

export async function api(path: string, opts?: RequestInit, sink?: TrafficSink): Promise<unknown> {
  if (opts?.body) sink?.("out", path, JSON.parse(opts.body as string));
  else sink?.("out", path, null);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
  return data;
}
