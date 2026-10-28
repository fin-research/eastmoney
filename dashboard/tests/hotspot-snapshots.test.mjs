import assert from "node:assert/strict";
import test from "node:test";

import {
  loadLatestHotspotSnapshot,
  saveHotspotSnapshot,
} from "../src/lib/server/hotspot-snapshots.ts";

function payload(articleIds = ["A001", "A002"]) {
  return JSON.stringify({
    date: "2026-08-21",
    marketSummary: "快照正文与证据范围来自同一次生成。",
    hotspots: Array.from({ length: 8 }, (_, index) => ({
      keyword: `快照热点${index + 1}`,
      aliases: [],
      explanation: "结构化证据支持该热点。",
      drivers: ["证据驱动"],
      conflicts: [],
      heat: 80 - index,
      assetImpacts: {
        fixedIncome: "固收影响",
        equities: "权益影响",
      },
      evidence: [{ articleId: articleIds[0], evidence: "证据摘要" }],
      confidence: "medium",
    })),
    relationships: [],
    watchItems: [],
    coverage: {
      analyzedArticleIds: articleIds,
      articleCount: articleIds.length,
    },
  });
}

function rollingScope(articleCount = 2) {
  return {
    mode: "rolling",
    rollingCount: 33,
    articleCount,
    firstPublishedAt: "2026-08-20T09:00:00+08:00",
    lastPublishedAt: "2026-08-21T15:00:00+08:00",
  };
}

test("首次访问按生成时间读取最新快照并采用快照内的证据范围", async () => {
  let sql = "";
  const database = {
    prepare(statement) {
      sql = statement;
      return {
        async first() {
          return {
            generated_at: "2026-08-21T08:00:00.000Z",
            model: "gpt-5.6-luna",
            scope: JSON.stringify(rollingScope()),
            payload: payload(),
          };
        },
      };
    },
  };

  const result = await loadLatestHotspotSnapshot(database);

  assert.match(sql, /ORDER BY generated_at DESC, snapshot_id DESC/);
  assert.equal(result.cached, true);
  assert.equal(result.scope.mode, "rolling");
  assert.equal(result.scope.rollingCount, 33);
  assert.deepEqual(result.coverage.analyzedArticleIds, ["A001", "A002"]);
  assert.equal(result.scope.articleCount, result.coverage.articleCount);
});

test("快照证据范围与正文覆盖数不一致时拒绝返回", async () => {
  const database = {
    prepare() {
      return {
        async first() {
          return {
            generated_at: "2026-08-21T08:00:00.000Z",
            model: "gpt-5.6-luna",
            scope: JSON.stringify(rollingScope(1)),
            payload: payload(),
          };
        },
      };
    },
  };

  await assert.rejects(
    loadLatestHotspotSnapshot(database),
    /证据范围与响应内容不一致/,
  );
});

test("每次生成使用纯 INSERT 追加完整快照", async () => {
  let sql = "";
  let bindings = [];
  const database = {
    prepare(statement) {
      sql = statement;
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async run() {},
      };
    },
  };
  const scope = rollingScope();

  await saveHotspotSnapshot(database, {
    inputFingerprint: "fingerprint",
    generatedAt: "2026-08-21T08:00:00.000Z",
    model: "gpt-5.6-luna",
    scope,
    payload: payload(),
  });

  assert.match(sql, /^INSERT INTO hotspot_snapshot/m);
  assert.doesNotMatch(sql, /ON CONFLICT/);
  assert.equal(bindings.length, 6);
  assert.match(bindings[0], /^[0-9a-f-]{36}$/);
  assert.equal(bindings[1], "fingerprint");
  assert.deepEqual(JSON.parse(bindings[4]), scope);
});
