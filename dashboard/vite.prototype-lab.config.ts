import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "./",
  envPrefix: ["VITE_", "PROTOTYPE_LAB_"],
  plugins: [tailwindcss(), svelte({ configFile: false })],
  resolve: {
    alias: {
      $lib: local("./src/lib/"),
    },
  },
  build: {
    outDir: local("./prototype-lab-dist"),
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: local("./index.html"),
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/echarts/") || id.includes("/node_modules/zrender/")) return "charts-vendor";
          if (id.includes("/node_modules/svelte/")) return "svelte-vendor";
        },
      },
    },
  },
});
