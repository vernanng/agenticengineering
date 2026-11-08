<script lang="ts">
  import { onMount } from "svelte";
  import { chat } from "./lib/chat.svelte";
  import { shape } from "./shape";
  import TopBar from "./components/TopBar.svelte";
  import SidePanel from "./components/SidePanel.svelte";
  import ChatLog from "./components/ChatLog.svelte";
  import InspectorPanel from "./components/InspectorPanel.svelte";
  import Composer from "./components/Composer.svelte";
  import LwcHello from "./components/LwcHello.svelte";
  import HelloPage from "./components/HelloPage.svelte";
  import { route } from "./lib/router.svelte";

  // Shape lives in ./shape.ts. To reshape, move one panel tag below
  // (each owns its grid wrapper) or flip a flag in shape.ts.
  onMount(() => {
    chat.init().catch((e) => {
      chat.bootError = "Could not reach the chat server. Start it with npm run dev, then retry. (" + e.message + ")";
    });
    return () => chat.destroy();
  });
</script>

<TopBar chat={chat} />

{#if route.path === "/hello"}
  <HelloPage />
{:else}
  <LwcHello />

  <div class="shell" data-layout={shape.layout}>
    {#if shape.layout === "triple"}
      <SidePanel chat={chat} />
    {/if}
    <ChatLog chat={chat} />
    {#if shape.layout === "triple" || shape.layout === "focus"}
      <InspectorPanel chat={chat} />
    {/if}
  </div>

  <Composer chat={chat} />
{/if}
