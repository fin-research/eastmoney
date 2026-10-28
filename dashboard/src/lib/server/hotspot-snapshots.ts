import {
  parseHotspotAnalysis,
  type HotspotApiResponse,
  type HotspotScope,
} from "../hotspots.ts";

interface SnapshotRow {
  generated_at: string;
  model: string;
  scope: string;
  payload: string;
}

interface SnapshotInput {
  inputFingerprint: string;
  generatedAt: string;
  model: string;
  scope: HotspotScope;
  payload: string;
}

export async function loadLatestHotspotSnapshot(
  database: Env["DB"],
): Promise<HotspotApiResponse | null> {
  const snapshot = await database
    .prepare(
      `SELECT generated_at, model, scope, payload
       FROM hotspot_snapshot
       ORDER BY generated_at DESC, snapshot_id DESC
       LIMIT 1`,
    )
    .first<SnapshotRow>();
  if (!snapshot) return null;

  const context = analysisContext(snapshot.payload);
  const analysis = parseHotspotAnalysis(snapshot.payload, context);
  const scope = parseScope(snapshot.scope);
  if (scope.articleCount !== analysis.coverage.articleCount) {
    throw new Error("热点快照的证据范围与响应内容不一致");
  }
  return {
    ...analysis,
    generatedAt: snapshot.generated_at,
    model: snapshot.model,
    cached: true,
    scope,
  };
}

export async function saveHotspotSnapshot(
  database: Env["DB"],
  input: SnapshotInput,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO hotspot_snapshot (
         snapshot_id, input_fingerprint, generated_at, model, scope, payload
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.inputFingerprint,
      input.generatedAt,
      input.model,
      JSON.stringify(input.scope),
      input.payload,
    )
    .run();
}

function analysisContext(payload: string): {
  date: string;
  articleIds: string[];
} {
  const value = parseObject(payload, "热点快照响应");
  const date = value.date;
  const coverage = parseObject(value.coverage, "热点快照 coverage");
  const articleIds = coverage.analyzedArticleIds;
  if (typeof date !== "string" || !date) {
    throw new Error("热点快照缺少有效日期");
  }
  if (
    !Array.isArray(articleIds) ||
    articleIds.length === 0 ||
    articleIds.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error("热点快照缺少有效证据文章");
  }
  return { date, articleIds: [...new Set(articleIds)] };
}

function parseScope(raw: string): HotspotScope {
  const value = parseObject(raw, "热点快照证据范围");
  const articleCount = integer(value.articleCount, "articleCount", 1, 100);
  const firstPublishedAt = text(value.firstPublishedAt, "firstPublishedAt");
  const lastPublishedAt = text(value.lastPublishedAt, "lastPublishedAt");
  if (firstPublishedAt > lastPublishedAt) {
    throw new Error("热点快照的证据发布时间范围无效");
  }
  if (value.mode === "rolling") {
    return {
      mode: "rolling",
      rollingCount: integer(value.rollingCount, "rollingCount", 8, 100),
      articleCount,
      firstPublishedAt,
      lastPublishedAt,
    };
  }
  if (value.mode === "range") {
    const startDate = isoDate(value.startDate, "startDate");
    const endDate = isoDate(value.endDate, "endDate");
    if (startDate > endDate) {
      throw new Error("热点快照的开始日期不能晚于结束日期");
    }
    return {
      mode: "range",
      startDate,
      endDate,
      articleCount,
      firstPublishedAt,
      lastPublishedAt,
    };
  }
  throw new Error("热点快照的证据范围模式无效");
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label}不是有效 JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}必须是对象`);
  }
  return parsed as Record<string, unknown>;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`热点快照的 ${field} 无效`);
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`热点快照的 ${field} 无效`);
  }
  return value;
}

function isoDate(value: unknown, field: string): string {
  const result = text(value, field);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(parsed.valueOf()) ||
    !parsed.toISOString().startsWith(result)
  ) {
    throw new Error(`热点快照的 ${field} 无效`);
  }
  return result;
}
