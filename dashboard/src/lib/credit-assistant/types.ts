import { z } from "zod";

export const creditQuestionSchema = z.object({ question: z.string().trim().min(1) }).strict();

export type CreditCitation = { sourceId: string; quote: string };
export type CreditSource = {
  id: string; documentId: string; title: string; locator: string;
  extraction: "ai_search"; url?: string;
};
export type CreditAnswer = {
  status: "complete" | "partial" | "insufficient";
  paragraphs: Array<{ text: string; citations: CreditCitation[] }>;
  gaps: string[];
  sources: CreditSource[];
  files: Array<{ id: string; title: string; url: string }>;
  createdAt: string;
};
export type CreditTurn = { id: string; question: string; answer: CreditAnswer; createdAt: string };
export type CreditSession = {
  turns: CreditTurn[]; running: boolean; progress: string; error: string | null; startedAt: number;
  pendingQuestion?: string;
  conversationId?: string;
  questionId?: string;
};

export function creditAnswerText(answer: CreditAnswer): string {
  const ids = [...new Set(answer.paragraphs.flatMap(paragraph => paragraph.citations.map(citation => citation.sourceId)))];
  const paragraphs = answer.paragraphs.map(paragraph => `${paragraph.text}${paragraph.citations.map(citation => `[${ids.indexOf(citation.sourceId) + 1}]`).join("")}`);
  if (answer.gaps.length) paragraphs.push(answer.gaps.join("\n"));
  if (ids.length) paragraphs.push(`资料来源：\n${ids.map((id, index) => {
    const source = answer.sources.find(item => item.id === id);
    return `[${index + 1}] ${source?.title ?? "检索片段"}`;
  }).join("\n")}`);
  if (answer.files.length) paragraphs.push(`随附材料：${answer.files.map(file => file.title).join("；")}`);
  return paragraphs.join("\n\n");
}
