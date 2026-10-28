import type { R2Bucket } from '@cloudflare/workers-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const PREFIX = 'credit/public/';
const MAX_FILES = 500;

export function publicCreditFileName(key: string): string | null {
  if (!key.startsWith(PREFIX)) return null;
  const title = key.slice(PREFIX.length);
  return /^[^/\\\u0000-\u001f\u007f]+\.pdf$/i.test(title)
    && new TextEncoder().encode(key).byteLength <= 1024 ? title : null;
}

export function legacyCreditFileId(key: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(key))).slice(0, 24);
}

export async function listPublicCreditFiles(bucket: R2Bucket) {
  const documents: Array<{ id: string; key: string; title: string; authority: 'audited' | 'disclosure'; url: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: PREFIX, limit: MAX_FILES, cursor });
    for (const object of page.objects) {
      const title = publicCreditFileName(object.key);
      if (!title) continue;
      documents.push({ id: legacyCreditFileId(object.key), key: object.key, title,
        authority: title.includes('审计报告') ? 'audited' : 'disclosure',
        url: `/api/credit-assistant/files/${encodeURIComponent(title)}` });
      if (documents.length > MAX_FILES) throw new Error('公开材料数量超过上限');
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return documents.sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'));
}
