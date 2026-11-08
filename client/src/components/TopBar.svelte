<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte";

  let { chat }: { chat: ChatStore } = $props();
</script>

<header class="topbar">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <div class="brandtext">
      <h1>Agent Engineering</h1>
      <span class="sub">Session operations</span>
    </div>
  </div>
  <div class="topmeta">
    <span class="status" data-state={chat.connection}>
      <span class="dot" aria-hidden="true"></span>
      {chat.connection === "live" ? (chat.runningTurnId ? "working" : "live") : chat.connection}
    </span>
    {#if chat.runningTurnId}
      <span class="runid" title={chat.runningTurnId}>turn {chat.runningTurnId.slice(0, 8)}…</span>
    {/if}
    <span class="sess" title={chat.sessionId ?? ""}>{chat.sessionId ?? "connecting…"}</span>
  </div>
  <div class="topactions">
    <label class="visually-hidden" for="profile">Permission profile</label>
    <select
      id="profile"
      bind:value={chat.selectedProfile}
      onchange={() => chat.newSession()}
      title="Permission profile for new chats"
    >
      <option value="">Host default</option>
      {#each chat.profiles as p}
        <option value={p.profileId} title={p.description ?? ""}>{p.label}</option>
      {/each}
    </select>
    <button class="ghost" onclick={() => (chat.trafficHidden = !chat.trafficHidden)} aria-expanded={!chat.trafficHidden}>
      {chat.trafficHidden ? "Show traffic" : "Hide traffic"}
    </button>
    <button class="ghost" onclick={() => chat.newSession()}>New chat</button>
  </div>
</header>
