<script lang="ts">
  import { onMount } from "svelte";
  import { createElement } from "lwc";
  // @ts-ignore - resolved by @lwc/rollup-plugin via lwc.config.json
  import Hello from "x/hello";

  let host: HTMLDivElement;

  onMount(() => {
    const elm = createElement("x-hello", { is: Hello });
    host.appendChild(elm);
    return () => elm.remove();
  });
</script>

<div class="panel">
  <div bind:this={host}></div>
</div>
