<script module lang="ts">
  export interface ApprovalChoice {
    choiceId: string;
    label?: string;
    rulePreview?: string;
    decision?: string;
    scope?: string;
  }

  export interface ApprovalRequest {
    approvalId: string;
    subject?: { title?: string; kind?: string };
    toolCallId?: string;
    rawArgs?: string;
    availableChoices?: ApprovalChoice[];
  }
</script>

<script lang="ts">
  import { api, type TrafficSink } from "../lib/api";
  import type { ApprovalVerdict } from "../lib/chat.svelte";

  interface Props {
    request: ApprovalRequest;
    sessionId: string | null;
    resolved: boolean;
    verdict?: ApprovalVerdict;
    sink?: TrafficSink;
    onDecided: (text: string) => void;
    onError: (text: string) => void;
  }

  let { request, sessionId, resolved, verdict, sink, onDecided, onError }: Props = $props();

  let decided: string | null = $state(null);
  let busy = $state(false);

  async function decide(choiceId: string, label: string) {
    decided = label;
    busy = true;
    try {
      await api(
        "/api/approval",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, approvalId: request.approvalId, choiceId }),
        },
        sink,
      );
      onDecided(`approval ${request.approvalId} decided: ${label}`);
    } catch (e) {
      busy = false;
      decided = null;
      onError("approval failed: " + (e as Error).message);
    }
  }
</script>

<div class="approval">
  <div>Muse needs approval — {request.subject?.title ?? request.toolCallId ?? request.subject?.kind ?? "tool call"}</div>
  {#if request.rawArgs}
    <details>
      <summary>Technical details</summary>
      <pre style="font-size:12px;overflow:auto;max-height:120px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px;">{request.rawArgs}</pre>
    </details>
  {/if}
  {#if !resolved}
    <div class="verdict">
      {#if !verdict || verdict.state === "checking"}Jev is checking this call…
      {:else if verdict.state === "safe"}Jev: safe ({verdict.noul})
      {:else if verdict.noul !== undefined}Jev: needs a human ({verdict.noul})
      {:else}Jev: check failed — your call{/if}
    </div>
  {/if}
  <div class="choices">
    {#each request.availableChoices ?? [] as c}
      <button
        class="ghost"
        disabled={busy || resolved || verdict?.state === "checking"}
        title={c.rulePreview ?? ""}
        onclick={() => decide(c.choiceId, c.label ?? c.choiceId)}
      >{c.label ?? c.choiceId}</button>
    {/each}
  </div>
  {#if decided ?? (resolved ? "Resolved" : null)}
    <div class="decided">Decided: {decided ?? "Resolved"}</div>
  {/if}
</div>
