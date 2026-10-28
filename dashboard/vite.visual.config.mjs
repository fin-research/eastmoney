import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
const local = path => fileURLToPath(new URL(path, import.meta.url));

// Component browser tests only: no SvelteKit server, bindings, .env or auth bypass.
export default defineConfig({
  root: local('./tests/visual/harness/'),
  envDir: false,
  worker: { format: "es" },
  plugins: [tailwindcss(), svelte({ configFile: false })],
  resolve: { alias: {
    $lib: local('./src/lib/'),
    '$app/forms': local('./tests/visual/harness/forms.js'),
    '$app/navigation': local('./tests/visual/harness/navigation.js'),
    '$app/stores': local('./tests/visual/harness/stores.js'),
    '$app/state': local('./tests/visual/harness/state.js'),
    '$app/environment': local('./tests/visual/harness/environment.js'),
  } },
  server: { host: '127.0.0.1', port: 8877, strictPort: true, fs: { allow: [local('./')] } },
  preview: { host: '127.0.0.1', port: 8877, strictPort: true },
  build: { outDir: local('./visual-dist'), emptyOutDir: true, cssCodeSplit: false, target: 'esnext' },
});
