import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    // Keep SvelteKit's generated request handler separate from Wrangler's
    // custom entrypoint, which also exports the bond import Workflow class.
    adapter: adapter({
      config: "wrangler.svelte.jsonc",
      platformProxy: {
        configPath: "wrangler.jsonc",
        remoteBindings: false,
      },
    }),
  },
};
