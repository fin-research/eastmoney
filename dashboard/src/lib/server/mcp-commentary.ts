import { z } from 'zod';
import { commentarySchema, commentaryListItemSchema } from '../commentary.ts';

// Publish standard business content; workspace files, originals and storage keys stay on the website.
export function projectCommentaryResult(name: string, value: unknown): unknown {
  if (['commentary', 'create_commentary', 'update_commentary'].includes(name)) return commentarySchema.parse(value);
  if (name === 'commentaries') return z.object({ items:z.array(commentaryListItemSchema), hasMore:z.boolean() }).parse(value);
  if (name === 'commentary_revisions') return z.object({ revisions:z.array(z.object({ savedAt:z.string(), content:commentarySchema })) }).parse(value);
  return value;
}
