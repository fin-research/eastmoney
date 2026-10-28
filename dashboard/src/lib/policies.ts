import type { CommentarySummary } from "./commentary.ts";
import { z } from "zod";

export const policyCategorySchema = z.enum([
  "monetary",
  "fiscal",
  "real_estate",
  "capital_market",
  "industry",
  "trade",
  "social",
  "other",
]);

export const policyImportanceSchema = z.enum([
  "important",
  "related",
  "general",
]);

export const articleAssociationUpdateSchema = z.object({
  articleIds: z.array(z.string().min(1)).max(100),
}).strict();

export type PolicyCategory = z.infer<typeof policyCategorySchema>;
export type PolicyImportance = z.infer<typeof policyImportanceSchema>;

export interface PolicyNews {
  id: string;
  newsId: string | null;
  title: string;
  publishedAt: string;
  link: string | null;
}

export interface PolicyArticle {
  id: string;
  title: string;
  author: string | null;
  summary: string;
  publishedAt: string;
  link: string | null;
  associationMethod: "ai" | "manual";
}

export interface PolicyEvent {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  importance: PolicyImportance;
  departments: string[];
  policyDate: string;
  firstNewsAt: string;
  lastNewsAt: string;
  updatedAt: string;
  news: PolicyNews[];
  articles: PolicyArticle[];
  commentary: CommentarySummary | null;
}

export interface PolicyTimelineResponse {
  policies: PolicyEvent[];
}

export interface ArticleSearchResult {
  id: string;
  title: string;
  author: string | null;
  summary: string;
  publishedAt: string;
  link: string | null;
}

export interface RelatedPolicySummary {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  policyDate: string;
}

export interface PolicyNewsDetail extends PolicyNews {
  content: string;
  policy: RelatedPolicySummary;
}

export interface ResearchReportDetail extends ArticleSearchResult {
  content: string;
  policies: RelatedPolicySummary[];
}

export interface CommentaryDetail {
  commentary: CommentarySummary;
  policy: RelatedPolicySummary | null;
}

export const policyCategoryLabels: Record<PolicyCategory, string> = {
  monetary: "货币政策",
  fiscal: "财政政策",
  real_estate: "房地产",
  capital_market: "资本市场",
  industry: "产业政策",
  trade: "贸易政策",
  social: "民生政策",
  other: "其他政策",
};

export const policyImportanceLabels: Record<PolicyImportance, string> = {
  important: "重要",
  related: "关联",
  general: "一般",
};
