import { z } from "zod";
import type { RelatedPolicySummary } from "./policies.ts";

export const commentaryTypeSchema = z.enum(["current_affairs", "policy_tracking", "overseas_event"]);
export type CommentaryType = z.infer<typeof commentaryTypeSchema>;

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "日期无效");
export const commentaryDraftSchema = z.object({
  eventName: z.string().trim().min(2).max(240),
  type: commentaryTypeSchema,
  eventPublishedAt: z.union([dateSchema, z.literal("")]),
  commentaryDate: z.union([dateSchema, z.literal("")]),
  sources: z.string().max(1000),
  eventSummary: z.string().max(8000),
  commentary: z.string().max(30000),
  recommendation: z.string().max(10000),
}).strict();
export const createCommentarySchema = commentaryDraftSchema.extend({ policyId: z.string().min(1).max(240).nullable().default(null) });
export const updateCommentarySchema = commentaryDraftSchema.extend({ updatedAt: z.string().min(1).max(80) });
export const generateCommentarySchema = z.object({
  startDate: dateSchema, endDate: dateSchema, updatedAt: z.string().min(1).max(80),
}).strict().refine(value => value.startDate <= value.endDate, "开始日期不能晚于结束日期");
export type CommentaryDraft = z.infer<typeof commentaryDraftSchema>;
export const commentarySchema = commentaryDraftSchema.extend({
  id: z.string(), policyId: z.string().nullable(),
  model: z.string().nullable(), promptVersion: z.string().nullable(), generatedAt: z.string().nullable(),
  edited: z.boolean(), updatedAt: z.string(),
}).strip();
export type CommentarySummary = z.infer<typeof commentarySchema>;
export const commentaryListItemSchema = commentarySchema.pick({ id:true, eventName:true, type:true, commentaryDate:true, edited:true, generatedAt:true });
export interface CommentaryEvidence {
  sourceId: string; sourceKey: string; title: string; institution: string; publishedAt: string;
  text: string; section: string; startOffset: number; endOffset: number; documentHash?: string;
}
export interface CommentaryPdfArchive { revisionAt: string; key: string; fileName: string; sha256: string; size: number; archivedAt: string }
export interface Commentary extends CommentarySummary {
  policy?: RelatedPolicySummary | null;
  pdf?: CommentaryPdfArchive | null;
  policyId: string | null;
  origin: "legacy" | "manual" | "import" | "ai";
  originalText: string;
  sourceFiles: Array<{ name: string; sha256: string }>;
  evidence: CommentaryEvidence[];
  search: { startDate: string; endDate: string; query: string; references?: Array<{ id: string; title: string; date: string }> } | null;
}
export interface CommentaryRevision { savedAt: string; content: Commentary }
export const commentaryTypeLabels = { current_affairs: "时事快评", policy_tracking: "政策跟踪", overseas_event: "海外事件" };
export function shanghaiDate(offset = 0): string {
  const now = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function commentaryText(value: CommentaryDraft): string {
  return `${value.eventName}\n消息来源：${value.sources}\n发布时间：${value.eventPublishedAt}\n点评时间：${value.commentaryDate}\n\n【事件摘要】\n${value.eventSummary}\n\n【跟踪点评】\n${value.commentary}\n\n【应对建议】\n${value.recommendation}`;
}
