import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary", "lcov"],
    },
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-11",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ARTICLE_API_BASE_URL: "https://eastmoney.hasbai.xyz/data" },
        d1Databases: ["DB"],
        r2Buckets: ["ARTICLE_BUCKET"],
        workflows: {
          OMO_WORKFLOW: { name: "omo", className: "OmoWorkflow" },
          ARTICLE_WORKFLOW: { name: "article", className: "ArticleWorkflow" },
          ARTICLE_BACKFILL_WORKFLOW: { name: "article-backfill", className: "ArticleBackfillWorkflow" },
          TELEGRAM_WORKFLOW: { name: "telegram", className: "TelegramWorkflow" },
          POLICY_WORKFLOW: { name: "policy-aggregation", className: "PolicyWorkflow" },
        },
      },
    }),
  ],
});
