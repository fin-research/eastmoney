<script lang="ts">
  import { onMount } from "svelte";
  import { logoutBearer } from "$lib/bearer-auth";
    onMount(() => { void logoutBearer(); });
</script>
