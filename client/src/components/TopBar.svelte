<script lang="ts">
  import type { ChatStore } from "../lib/chat.svelte.ts";
  import { navigate, route } from "../lib/router.svelte.ts";
  import SettingsMenu from "./SettingsMenu.svelte";

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
    {#if route.path !== "/"}
      <button class="ghost" onclick={() => navigate("/")}>Dashboard</button>
    {/if}
    {#if route.path !== "/judge"}
      <button class="ghost" onclick={() => navigate("/judge")}>Judge</button>
    {/if}
    {#if route.path !== "/hello"}
      <button class="ghost" onclick={() => navigate("/hello")}>LWC demo</button>
    {/if}
    <SettingsMenu chat={chat} />
    <button class="ghost" onclick={() => chat.newSession()}>New chat</button>
  </div>
</header>
