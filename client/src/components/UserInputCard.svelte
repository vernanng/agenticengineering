<script module lang="ts">
  export interface UserInputOption {
    label: string;
    description?: string;
  }

  export interface UserInputQuestion {
    id: string;
    header?: string;
    question: string;
    selection?: { mode?: string };
    options?: UserInputOption[];
  }

  export interface UserInputRequest {
    userInputId: string;
    toolName?: string;
    questions?: UserInputQuestion[];
  }

  interface Answer {
    questionId: string;
    selectedLabel?: string;
    selectedLabels?: string[];
    freeText?: string;
  }
</script>

<script lang="ts">
  import { api, type TrafficSink } from "../lib/api";

  interface Props {
    request: UserInputRequest;
    sessionId: string | null;
    settled: boolean;
    sink?: TrafficSink;
    onSettled: () => void;
    onError: (text: string) => void;
  }

  let { request, sessionId, settled, sink, onSettled, onError }: Props = $props();

  let picked = $state<Record<string, string[]>>({});
  let custom = $state<Record<string, string>>({});
  let hint = $state("");
  let busy = $state(false);
  let done = $state(false);

  const disabled = $derived(done || settled || busy);

  function toggle(qid: string, label: string, multi: boolean) {
    const cur = picked[qid] ?? [];
    picked[qid] = multi
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label];
  }

  async function answer() {
    const answers: Answer[] = [];
    for (const q of request.questions ?? []) {
      const free = (custom[q.id] ?? "").trim();
      if (free) {
        answers.push({ questionId: q.id, freeText: free });
        continue;
      }
      const sel = picked[q.id] ?? [];
      const multi = q.selection?.mode === "multiple";
      if (multi ? sel.length === 0 : sel.length !== 1) {
        hint = "Answer every question to continue.";
        return;
      }
      answers.push(
        multi ? { questionId: q.id, selectedLabels: sel } : { questionId: q.id, selectedLabel: sel[0] },
      );
    }
    busy = true;
    hint = "";
    try {
      await api(
        "/api/user-input",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, userInputId: request.userInputId, answers }),
        },
        sink,
      );
      done = true;
      onSettled();
    } catch (e) {
      busy = false;
      hint = "Could not send: " + (e as Error).message;
      onError("Could not send answers: " + (e as Error).message);
    }
  }
</script>

<div class="approval">
  <div>Muse asks: {request.toolName ?? "a tool"} needs input</div>
  {#each request.questions ?? [] as q}
    <div style="margin-top:8px;">
      <div style="font-weight:600;">{q.header ? `${q.header}: ${q.question}` : q.question}</div>
      {#each q.options ?? [] as o}
        {@const multi = q.selection?.mode === "multiple"}
        <label style="display:block;font-size:13px;margin-top:4px;">
          <input
            type={multi ? "checkbox" : "radio"}
            name={"q-" + q.id}
            value={o.label}
            checked={(picked[q.id] ?? []).includes(o.label)}
            title={o.description ?? ""}
            disabled={disabled}
            onchange={() => toggle(q.id, o.label, multi)}
          />
          {" " + o.label}
        </label>
      {/each}
      <input
        placeholder="Or type a custom answer…"
        value={custom[q.id] ?? ""}
        oninput={(e) => (custom[q.id] = (e.target as HTMLInputElement).value)}
        disabled={disabled}
        style="margin-top:4px;width:100%;font-size:13px;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);"
      />
    </div>
  {/each}
  <div style="font-size:12px;color:var(--warn-ink);margin-top:6px;">{hint}</div>
  <div class="choices">
    <button class="ghost" disabled={disabled} onclick={answer}>Answer</button>
  </div>
</div>
