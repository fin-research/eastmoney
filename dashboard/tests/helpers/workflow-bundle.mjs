import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Compile the real Svelte Flow package (which ships .svelte files) while sharing
// the DOM harness's Svelte runtime and global message store.
export async function loadWorkflowView() {
  const root = new URL('../../', import.meta.url);
  const outDir = new URL('.svelte-kit/workflow-dom/', root);
  await build({
    configFile: false, logLevel: 'silent', plugins: [svelte()],
    resolve: { alias: { '$lib': fileURLToPath(new URL('src/lib/', root)) } },
    build: {
      outDir: fileURLToPath(outDir), emptyOutDir: true, minify: false,
      lib: { entry: fileURLToPath(new URL('src/lib/trading-research/WorkflowView.svelte', root)), formats: ['es'], fileName: () => 'workflow.mjs' },
      rollupOptions: { external: id => /^svelte(?:\/|$)/.test(id) || id.endsWith('/global-messages'),
        output: { paths: id => id.endsWith('/global-messages') ? '../../src/lib/global-messages.ts' : id } },
    },
  });
  return (await import(new URL('workflow.mjs', outDir).href)).default;
}
