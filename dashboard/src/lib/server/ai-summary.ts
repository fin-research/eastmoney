/** Keep public reasoning summaries plain text before they cross an SSE boundary. */
export function sanitizeReasoningSummary(summary: string): string {
  return summary
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^_+|_+$/g, "")
    .trim();
}
