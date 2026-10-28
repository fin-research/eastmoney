<script lang="ts">
  import { onMount } from "svelte";
  import { loginRedirect } from "$lib/bearer-auth";
  import { goto } from "$app/navigation";
  onMount(() => { void goto('/auth/login?error=callback'); });
</script>
