<script lang="ts">
  import { approvalTitle, type ChatStore } from "../lib/chat.svelte";
  import { shape } from "../shape";

  let { chat }: { chat: ChatStore } = $props();
</script>

<aside class="inspector" aria-label="Attention and traffic">
  <section class="panel" id="panel-attention" aria-label="Needs attention">
    <h2>Needs attention</h2>
    {#if chat.pendingApprovalEntries.length === 0 && chat.pendingInputEntries.length === 0}
      <p class="muted">All clear. New approvals and tool questions will queue here.</p>
    {:else}
      <ul class="queue">
        {#each chat.pendingApprovalEntries as e (e.id)}
          {#if e.type === "approval"}
            <li><span class="tag">approval</span> {approvalTitle(e.request)}</li>
          {/if}
        {/each}
        {#each chat.pendingInputEntries as e (e.id)}
          {#if e.type === "userinput"}
            <li>
              <span class="tag">question</span>
              {e.request.toolName ?? "tool"} · {(e.request.questions ?? []).length} question{(e.request.questions ?? []).length === 1 ? "" : "s"}
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  </section>

  {#if shape.showTraffic}
    <section class="panel" id="panel-traffic" aria-label="Protocol traffic" hidden={chat.trafficHidden}>
      <h2>Traffic</h2>
      {#if chat.traffic.length === 0}
        <p class="muted">No API or stream events yet.</p>
      {:else}
        <ol class="trafficlist">
          {#each chat.traffic as t (t.id)}
            <li>
              <div class={t.dir === "in" ? "tin" : "tout"}>{t.dir === "in" ? "← " : "→ "}{t.label}</div>
              {#if t.text !== null}
                <pre title={t.title}>{t.text}</pre>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}
</aside>
