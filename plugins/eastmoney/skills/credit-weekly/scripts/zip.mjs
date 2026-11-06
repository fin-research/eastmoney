// 最小 ZIP 读写（xlsx 包用）：读 stored / deflate，写 deflate；条目保持顺序，名称按 UTF-8。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX_BYTES = 512 * 1024 * 1024;

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(buf) { let crc = ~0; for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC[(crc ^ buf[i]) & 0xff]; return ~crc >>> 0; }

/** @returns {Map<string, Buffer>} 条目名 → 内容（保持包内顺序） */
export function readZip(buffer) {
  if (buffer.length > MAX_BYTES) throw new Error('ZIP 过大');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（ZIP 结构损坏）');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = new TextDecoder('utf-8').decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('不支持加密的 xlsx');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    const data = method === 0 ? body : method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : null;
    if (!data) throw new Error(`不支持的压缩方式：${name}`);
    if (data.length !== size) throw new Error(`ZIP 文件长度不符：${name}`);
    if (entries.has(name)) throw new Error(`ZIP 包含重复条目：${name}`);
    entries.set(name, Buffer.from(data));
  }
  return entries;
}

/** @param {Map<string, Buffer>} entries */
export function writeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, body); central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
