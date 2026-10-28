export type HotspotConfidence = "high" | "medium" | "low";

export interface EvidenceReference {
  articleId: string;
  evidence: string;
}

export interface Hotspot {
  keyword: string;
  aliases: string[];
  heat: number;
  sourceLabel: "单一来源" | "多来源";
  conflicts: string[];
  explanation: string;
  drivers: string[];
  assetImpacts: {
    fixedIncome: string;
    equities: string;
  };
  evidence: EvidenceReference[];
  confidence: HotspotConfidence;
}

export interface HotspotAnalysis {
  date: string;
  marketSummary: string;
  hotspots: Hotspot[];
  relationships: Array<{
    source: string;
    target: string;
    explanation: string;
  }>;
  watchItems: string[];
  coverage: {
    analyzedArticleIds: string[];
    articleCount: number;
  };
}

export interface HotspotApiResponse extends HotspotAnalysis {
  generatedAt: string;
  model: string;
  cached: boolean;
  scope: HotspotScope;
}

export type HotspotGenerationScope =
  | { mode: "rolling"; rollingCount: number }
  | { mode: "range"; startDate: string; endDate: string };

export type HotspotScope =
  | {
      mode: "rolling";
      rollingCount: number;
      articleCount: number;
      firstPublishedAt: string;
      lastPublishedAt: string;
    }
  | {
      mode: "range";
      startDate: string;
      endDate: string;
      articleCount: number;
      firstPublishedAt: string;
      lastPublishedAt: string;
    };

interface ParseContext {
  date: string;
  articleIds: string[];
}

export function parseHotspotAnalysis(
  raw: string,
  context: ParseContext,
): HotspotAnalysis {
  const value = parseJsonObject(raw);
  const validArticleIds = new Set(context.articleIds);
  const parsedHotspots = arrayValue(value.hotspots, "hotspots")
    .map((item, index) => parseHotspot(item, index, validArticleIds))
    .filter((item): item is Hotspot => item !== null);

  const uniqueHotspots = new Map<string, Hotspot>();
  for (const hotspot of parsedHotspots) {
    const key = hotspot.keyword.replaceAll(/\s+/g, "").toLocaleLowerCase("zh-CN");
    if (!uniqueHotspots.has(key)) uniqueHotspots.set(key, hotspot);
  }
  const hotspots = [...uniqueHotspots.values()]
    .sort((left, right) => right.heat - left.heat)
    .slice(0, 15);
  if (hotspots.length < 8) {
    throw new Error("model output must contain 8-15 valid hotspots");
  }

  const keywordSet = new Set(hotspots.map((hotspot) => hotspot.keyword));
  const relationships = arrayValue(value.relationships, "relationships")
    .map((item) => {
      const row = objectValue(item, "relationship");
      return {
        source: requiredString(row.source, "relationship.source", 40),
        target: requiredString(row.target, "relationship.target", 40),
        explanation: requiredString(
          row.explanation,
          "relationship.explanation",
          500,
        ),
      };
    })
    .filter(
      (item) =>
        item.source !== item.target &&
        keywordSet.has(item.source) &&
        keywordSet.has(item.target),
    );

  return {
    date: context.date,
    marketSummary: requiredString(value.marketSummary, "marketSummary"),
    hotspots,
    relationships,
    watchItems: stringArray(value.watchItems, "watchItems", 12, 300),
    coverage: {
      analyzedArticleIds: [...context.articleIds],
      articleCount: context.articleIds.length,
    },
  };
}

function parseHotspot(
  value: unknown,
  index: number,
  validArticleIds: Set<string>,
): Hotspot | null {
  const row = objectValue(value, `hotspots[${index}]`);
  const impacts = objectValue(
    row.assetImpacts,
    `hotspots[${index}].assetImpacts`,
  );
  const evidenceByArticle = new Map<string, EvidenceReference>();
  for (const item of arrayValue(row.evidence, `hotspots[${index}].evidence`)) {
    const reference = objectValue(item, "evidence reference");
    const articleId = requiredString(reference.articleId, "articleId", 160);
    if (!validArticleIds.has(articleId) || evidenceByArticle.has(articleId)) continue;
    evidenceByArticle.set(articleId, {
      articleId,
      evidence: requiredString(reference.evidence, "evidence", 500),
    });
  }
  const evidence = [...evidenceByArticle.values()].slice(0, 5);
  if (evidence.length === 0) return null;

  const rawConfidence = requiredString(row.confidence, "confidence", 12);
  if (!isConfidence(rawConfidence)) {
    throw new Error(`invalid confidence: ${rawConfidence}`);
  }
  const confidence =
    evidence.length === 1 && rawConfidence === "high" ? "medium" : rawConfidence;
  // heat 由模型直接给出，应用不自行按权重公式计算；单来源规则只做封顶校验
  const heat = Math.round(clamp(requiredNumber(row.heat, "heat"), 0, 100));
  const finalHeat = evidence.length === 1 ? Math.min(60, heat) : heat;

  return {
    keyword: requiredString(row.keyword, "keyword", 40),
    aliases: stringArray(row.aliases, "aliases", 8, 40),
    heat: finalHeat,
    sourceLabel: evidence.length === 1 ? "单一来源" : "多来源",
    conflicts: stringArray(row.conflicts, "conflicts", 6, 300),
    explanation: requiredString(row.explanation, "explanation", 1_000),
    drivers: stringArray(row.drivers, "drivers", 8, 160),
    assetImpacts: {
      fixedIncome: requiredString(impacts.fixedIncome, "fixedIncome", 500),
      equities: requiredString(impacts.equities, "equities", 500),
    },
    evidence,
    confidence,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  try {
    return objectValue(JSON.parse(cleaned) as unknown, "model output");
  } catch (error) {
    throw new Error(`model output is not valid JSON: ${errorMessage(error)}`);
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function stringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  return arrayValue(value, name)
    .slice(0, maxItems)
    .map((item) => requiredString(item, name, maxLength));
}

function requiredString(
  value: unknown,
  name: string,
  maxLength?: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new Error(`${name} is too long`);
  }
  return trimmed;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function isConfidence(value: string): value is HotspotConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
