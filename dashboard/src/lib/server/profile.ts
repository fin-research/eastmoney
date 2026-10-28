export class ProfileError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function readProfileJson(source: Request | Response, maxBytes: number): Promise<unknown> {
  const reader = source.body?.getReader();
  if (!reader) throw new ProfileError(400, '请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ProfileError(413, '请求内容过大'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ProfileError(400, '请求内容无效'); }
  } finally { reader.releaseLock(); }
}
