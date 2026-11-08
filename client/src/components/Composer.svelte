<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte.ts";

  let { chat }: { chat: ChatStore } = $props();

  let text = $state("");

  async function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await chat.sendText(text)) text = "";
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
