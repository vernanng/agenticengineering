<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte";

  let { chat }: { chat: ChatStore } = $props();
  let open = $state(false);

  function close() {
    open = false;
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<div class="settings">
  <button
    class="ghost"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="settings-menu"
    onclick={() => (open = !open)}
  >
    Settings
  </button>
  {#if open}
    <button class="settings-backdrop" aria-hidden="true" tabindex="-1" onclick={close}></button>
    <div class="settings-menu" role="menu" id="settings-menu">
      <label class="settings-row" for="settings-profile">
        <span>Permission profile</span>
        <select
          id="settings-profile"
          bind:value={chat.selectedProfile}
          onchange={() => {
            chat.newSession();
            close();
          }}
        >
          <option value="">Host default</option>
          {#each chat.profiles as p}
            <option value={p.profileId} title={p.description ?? ""}>{p.label}</option>
          {/each}
        </select>
      </label>
      <button
        class="ghost settings-row-btn"
        role="menuitemcheckbox"
        aria-checked={!chat.trafficHidden}
        onclick={() => (chat.trafficHidden = !chat.trafficHidden)}
      >
        {chat.trafficHidden ? "Show traffic" : "Hide traffic"}
      </button>
    </div>
  {/if}
</div>
