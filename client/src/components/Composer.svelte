<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte";

  let { chat }: { chat: ChatStore } = $props();

  let text = $state("");

  function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const pending = text;
    text = "";
    void chat.sendText(pending);
  }
</script>

<footer>
  <form onsubmit={onsubmit}>
    <label class="visually-hidden" for="composer">Message Muse</label>
    <input
      id="composer"
      bind:value={text}
      autocomplete="off"
      placeholder="Ask Muse anything about this workspace…"
    />
    {#if chat.runningTurnId}
      <button type="button" disabled={chat.stopping} onclick={() => chat.stopTurn()}>Stop</button>
    {:else}
      <button type="submit">Send</button>
    {/if}
  </form>
</footer>
