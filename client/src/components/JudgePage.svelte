<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte.ts";
  import { evaluate } from "../lib/api.ts";
  import { navigate } from "../lib/router.svelte.ts";

  let { chat }: { chat: ChatStore } = $props();

  type QType = "noul" | "choice" | "score";
  interface Q {
    name: string;
    type: QType;
    instructions: string;
    criteria: string; // choice: "key: description" per line; score: one level per line
  }

  const TICKET =
    "Our API integration started returning 500 errors on every request about 20 minutes ago, and we can't process any customer orders until this is fixed.";

  let state = $state(TICKET);
  let model = $state("");
  let questions = $state<Q[]>([
    {
      name: "department",
      type: "choice",
      instructions: "Which team should handle this",
      criteria: "billing: Payment or subscription problems\ntechnical: Bugs or integration problems\nsales: Pricing or account questions",
    },
    {
      name: "frustration",
      type: "score",
      instructions: "How frustrated the customer appears",
      criteria: "Calm, just stating facts\nFrustrated but civil\nVery angry, strong language",
    },
    { name: "is_urgent", type: "noul", instructions: "The message conveys urgency or time-sensitivity", criteria: "" },
  ]);
  let answers = $state<Record<string, Record<string, unknown>> | null>(null);
  let usedModel = $state("");
  let error = $state("");
  let busy = $state(false);

  function addQuestion() {
    questions.push({ name: "", type: "noul", instructions: "", criteria: "" });
  }

  function criteriaOf(q: Q): Record<string, string> | string[] {
    if (q.type === "choice") {
      const o: Record<string, string> = {};
      for (const line of q.criteria.split("\n")) {
        const i = line.indexOf(":");
        if (i > 0 && line.slice(0, i).trim()) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return o;
    }
    return q.criteria
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function run(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    answers = null;
    if (!state.trim()) {
      error = "State is required.";
      return;
    }
    const qs: Record<string, unknown> = {};
    for (const q of questions) {
      if (!q.name.trim() || !q.instructions.trim()) {
        error = "Each question needs a name and instructions.";
        return;
      }
      const body: Record<string, unknown> = { type: q.type, instructions: q.instructions.trim() };
      if (q.type !== "noul") {
        const c = criteriaOf(q);
        if (Object.keys(c).length === 0) {
          error = `Question "${q.name.trim()}" needs criteria.`;
          return;
        }
        body.criteria = c;
      }
      qs[q.name.trim()] = body;
    }
    if (Object.keys(qs).length === 0) {
      error = "Add at least one question.";
      return;
    }
    busy = true;
    try {
      const r = await evaluate(state, qs, model.trim() || undefined, chat.sink);
      answers = r.answers as Record<string, Record<string, unknown>>;
      usedModel = r.model;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function main(a: Record<string, unknown>): string {
    if (a.type === "choice") return String(a.choice);
    if (a.type === "score") return String(a.score);
    if (a.type === "noul") return String(a.noul);
    return JSON.stringify(a);
  }

  function label(a: Record<string, unknown>, k: string): string {
    const legend = a.legend as Record<string, string> | undefined;
    return legend?.[k] ?? k;
  }
</script>

<div class="page" aria-label="TypeSafe judge">
  <div class="panel">
    <h2>TypeSafe judge</h2>
    <p class="muted">
      One state, several typed questions, one request — as in the
      <a href="https://docs.typesafe.ai/introduction/quickstart">quickstart</a>.
      Box questions need image upload, which this client does not send yet.
    </p>
    <p><button class="navlink" onclick={() => navigate("/")}>← Back to dashboard</button></p>
  </div>

  <form class="panel" onsubmit={run} aria-label="Judge request">
    <h2>State</h2>
    <textarea id="judge-state" bind:value={state} rows="4" aria-label="State to evaluate"></textarea>
    <h2>Questions</h2>
    {#each questions as q, i (i)}
      <div class="qrow">
        <input bind:value={q.name} placeholder="name" aria-label="Question name" />
        <select bind:value={q.type} aria-label="Question type">
          <option value="noul">noul</option>
          <option value="choice">choice</option>
          <option value="score">score</option>
        </select>
        <button type="button" class="ghost" onclick={() => questions.splice(i, 1)}>Remove</button>
        <input
          class="wide"
          bind:value={q.instructions}
          placeholder="instructions — what to judge"
          aria-label="Question instructions"
        />
        {#if q.type !== "noul"}
          <textarea
            class="wide"
            bind:value={q.criteria}
            rows="3"
            placeholder={q.type === "choice" ? "one option per line: key: description" : "one level per line, calm first"}
            aria-label="Question criteria"
          ></textarea>
        {/if}
      </div>
    {/each}
    <p>
      <button type="button" class="ghost" onclick={addQuestion}>Add question</button>
    </p>
    <h2>Model</h2>
    <input
      bind:value={model}
      placeholder="jev-latest (or blank for the server default)"
      aria-label="Model override"
    />
    <p>
      <button type="submit" disabled={busy}>{busy ? "Judging…" : "Judge"}</button>
    </p>
  </form>

  {#if error}
    <div class="panel" role="alert">
      <h2>Error</h2>
      <p class="muted">{error}</p>
    </div>
  {/if}

  {#if answers}
    <div class="panel" aria-label="Answers">
      <h2>Answers · {usedModel}</h2>
      <ul class="queue">
        {#each Object.entries(answers) as [name, a] (name)}
          <li>
            <span class="tag">{String(a.type)}</span>
            <strong>{name}</strong> → {main(a)}
            {#if typeof a.confidence === "number"}
              <span class="muted"> · confidence {a.confidence}</span>
            {/if}
            {#if a.probabilities && typeof a.probabilities === "object"}
              <ul class="queue">
                {#each Object.entries(a.probabilities as Record<string, number>) as [k, p] (k)}
                  <li>{label(a, k)} — {Math.round(p * 100)}%</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  textarea,
  input,
  select {
    width: 100%;
    box-sizing: border-box;
    margin: 4px 0 8px;
  }
  textarea {
    font: inherit;
    resize: vertical;
  }
  .qrow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 0;
    border-top: 1px solid var(--line);
  }
  .qrow input:not(.wide),
  .qrow select {
    flex: 1 1 120px;
    width: auto;
  }
  .qrow .wide {
    flex: 1 1 100%;
  }
</style>
