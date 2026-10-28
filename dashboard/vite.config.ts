import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { Agent as HttpsAgent } from "node:https";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const dataProxyTarget = environment.DATA_PROXY_TARGET?.trim();
  const dataProxyOrigin = dataProxyTarget
    ? new URL(dataProxyTarget).origin
    : undefined;
  if (command === "serve" && mode === "dev" && !dataProxyTarget) {
    throw new Error("DATA_PROXY_TARGET must be configured in .env.dev");
  }
  const dataProxyAgent = dataProxyTarget?.startsWith("https:")
    ? new HttpsAgent({ keepAlive: false, proxyEnv: process.env })
    : undefined;

  return {
    plugins: [tailwindcss(), sveltekit()],
    worker: { format: "es" },
    server: {
      host: "127.0.0.1",
      port: 8765,
      strictPort: true,
      proxy: dataProxyTarget
        ? {
            "/data": {
              target: dataProxyTarget,
              changeOrigin: true,
              agent: dataProxyAgent,
            },
            "/api/bond-ledger": {
              target: dataProxyTarget,
              changeOrigin: true,
              agent: dataProxyAgent,
              headers: dataProxyOrigin ? { Origin: dataProxyOrigin } : undefined,
            },
          }
        : undefined,
    },
    preview: {
      host: "127.0.0.1",
      port: 8765,
      strictPort: true,
    },
    build: {
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (
              id.includes("/node_modules/echarts/") ||
              id.includes("/node_modules/zrender/")
            ) {
              return "charts-vendor";
            }
            if (id.includes("/node_modules/html-to-image/")) {
              return "export-vendor";
            }
            if (id.includes("/node_modules/svelte/")) {
              return "svelte-vendor";
            }
          },
        },
      },
    },
  };
});
