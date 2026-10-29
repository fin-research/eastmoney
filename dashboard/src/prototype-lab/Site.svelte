<script lang="ts">
  import App from "../App.svelte";
  import { provideAiClient } from "$lib/ai-client.svelte";
  import GlobalMessages from "$lib/GlobalMessages.svelte";

  provideAiClient();
</script>

<GlobalMessages />
<App staticMode />
