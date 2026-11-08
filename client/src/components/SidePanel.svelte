<script lang="ts">
  import { scrollToId, type ChatStore } from "../lib/chat.svelte.ts";
  import { shape } from "../shape.ts";

  let { chat }: { chat: ChatStore } = $props();
</script>

<aside class="side" aria-label="Session overview">
  <nav aria-label="Dashboard sections">
    <button class="navlink" onclick={() => scrollToId("panel-chat")}>Chat</button>
    <button class="navlink" onclick={() => scrollToId("panel-attention")}>
      Approvals
      {#if chat.pendingApprovalEntries.length + chat.pendingInputEntries.length > 0}
        <span class="badge">{chat.pendingApprovalEntries.length + chat.pendingInputEntries.length}</span>
      {/if}
    </button>
    {#if shape.showTraffic}
      <button class="navlink" onclick={() => scrollToId("panel-traffic")}>Traffic</button>
    {/if}
    <button class="navlink" onclick={() => scrollToId("panel-session")}>Session</button>
  </nav>

  {#if shape.showStats}
    <section class="panel" aria-label="Run figures">
      <h2>Run figures</h2>
      <dl class="stats">
        <div><dt>Messages</dt><dd>{chat.messageCount}</dd></div>
        <div><dt>Turns done</dt><dd>{chat.turnCount}</dd></div>
        <div><dt>Open approvals</dt><dd>{chat.pendingApprovalEntries.length}</dd></div>
        <div><dt>Open questions</dt><dd>{chat.pendingInputEntries.length}</dd></div>
        <div><dt>Traffic events</dt><dd>{chat.traffic.length}</dd></div>
        <div><dt>Errors</dt><dd>{chat.errorCount}</dd></div>
      </dl>
    </section>
  {/if}

  <section class="panel" id="panel-session" aria-label="Session details">
    <h2>Session</h2>
    <p class="sessfull">{chat.sessionId ?? "connecting…"}</p>
    <p class="muted">
      {chat.runningTurnId ? `Turn ${chat.runningTurnId} running.` : "Idle. Send a message to start a turn."}
    </p>
    {#if chat.fingerprintWarning}
      <p class="warn">{chat.fingerprintWarning}</p>
    {/if}
  </section>
</aside>
