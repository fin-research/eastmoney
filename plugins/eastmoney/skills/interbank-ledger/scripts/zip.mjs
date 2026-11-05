// 最小 ZIP 读取：只支持 stored / deflate，解析中央目录，文件名缺 UTF-8 标志时按 GB18030 解码。
import { inflateRawSync } from 'node:zlib';

const MAX_BYTES = 100 * 1024 * 1024;

export function readZip(buffer) {
  if (buffer.length > MAX_BYTES) throw new Error('ZIP 超过 100 MB');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let expanded = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const raw = buffer.subarray(offset + 46, offset + 46 + nameLength);
    // 有 UTF-8 标志或字节本身是合法 UTF-8（macOS Finder 压缩）按 UTF-8，否则按 GB18030。
    const name = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { if (flags & 0x800) throw new Error('ZIP 文件名编码无效'); return new TextDecoder('gb18030').decode(raw); } })();
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part.includes(':'))) throw new Error('压缩包路径无效');
    if (flags & 1) throw new Error('不支持加密 ZIP');
    expanded += size;
    if (expanded > MAX_BYTES) throw new Error('解压文件超过 100 MB');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    const data = method === 0 ? body : method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : null;
    if (!data) throw new Error(`不支持的压缩方式：${name}`);
    if (data.length !== size) throw new Error(`ZIP 文件长度不符：${name}`);
    const key = name.toLowerCase();
    if (entries.has(key)) throw new Error('ZIP 包含重复文件名');
    entries.set(key, { name, data: Buffer.from(data) });
  }
  return [...entries.values()];
}
