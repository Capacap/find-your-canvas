<script lang="ts">
  let { children } = $props();
</script>

<svelte:head>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</svelte:head>

{@render children()}

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    background: #1a1715;
  }
</style>
