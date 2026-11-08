<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte";
  import ApprovalCard from "./ApprovalCard.svelte";
  import UserInputCard from "./UserInputCard.svelte";

  let { chat }: { chat: ChatStore } = $props();
</script>

<main class="center" id="panel-chat">
  {#if chat.fingerprintWarning}
    <div class="warnbanner" role="status">{chat.fingerprintWarning}</div>
  {/if}
  {#if chat.bootError}
    <div class="warnbanner" role="alert">
      {chat.bootError}
      <button
        class="ghost"
        onclick={() => {
          chat.bootError = null;
          chat.init().catch((e) => (chat.bootError = "Could not reach the chat server. (" + e.message + ")"));
        }}
      >Retry</button>
    </div>
  {/if}

  <div id="log" aria-live="polite">
    {#each chat.entries as e (e.id)}
      {#if e.type === "msg"}
        <div class="msg {e.cls}" class:streaming={e.streaming}>
          <div class="kind">{e.kind}</div>
          <div>{e.text}</div>
        </div>
      {:else if e.type === "term"}
        <div class="terminal">{e.text}</div>
      {:else if e.type === "approval"}
        <ApprovalCard
          request={e.request}
          sessionId={chat.sessionId}
          resolved={e.resolved}
          verdict={e.verdict}
          sink={chat.sink}
          onDecided={(text) => chat.pushTerm(text)}
          onError={(text) => chat.pushError(text)}
        />
      {:else if e.type === "userinput"}
        <UserInputCard
          request={e.request}
          sessionId={chat.sessionId}
          settled={e.settled}
          sink={chat.sink}
          onSettled={() => chat.settleUserInput(e, e.request.userInputId)}
          onError={(text) => chat.pushError(text)}
        />
      {/if}
    {/each}
    {#if chat.entries.length === 0}
      <div class="empty">
        <h2>No activity yet</h2>
        <p>Send the first message below. Turns, tool output, approvals, and questions appear here in order.</p>
      </div>
    {/if}
  </div>
</main>
