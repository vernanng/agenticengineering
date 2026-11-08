<script lang="ts">
  import { navigate } from "../lib/router.svelte";
  import LwcHello from "./LwcHello.svelte";
</script>

<div class="page" aria-label="LWC demo">
  <div class="panel">
    <h2>Hello route</h2>
    <p class="muted">Deep link works: this page renders the LWC element under a real route.</p>
    <p><button class="navlink" onclick={() => navigate("/")}>← Back to dashboard</button></p>
  </div>
  <LwcHello />
  <div class="panel">
    <h2>About this route</h2>
    <p class="muted">This element only renders on /hello, outside the chat shell.</p>
  </div>
</div>
