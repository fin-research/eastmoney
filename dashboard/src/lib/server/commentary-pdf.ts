import { renderCommentaryPdf, commentaryPdfKey } from "../research-commentary-pdf.ts";
import { getCommentary } from "./commentary-repository.ts";
import { PolicyRepositoryError } from "./policy-repository.ts";
import type { CommentaryPdfArchive } from "../commentary.ts";

export async function getCommentaryPdfArchive(db: Env["DB"], id: string, version: string): Promise<CommentaryPdfArchive | null> {
  return await db.prepare(`SELECT revision_at AS revisionAt, r2_key AS key, file_name AS fileName,
    sha256, byte_size AS size, archived_at AS archivedAt FROM commentary_pdf WHERE commentary_id=? AND revision_at=?`)
    .bind(id,version).first<CommentaryPdfArchive>();
}
export async function archiveCommentaryPdf(env: Env, id: string, expectedVersion: string, uploadedBytes?: Uint8Array<ArrayBuffer>): Promise<CommentaryPdfArchive> {
  if (!env.EASTMONEY) throw new PolicyRepositoryError(503,"PDF 归档存储尚未配置");
  const commentary = await getCommentary(env.DB,id);
  if (commentary.updatedAt !== expectedVersion) throw new PolicyRepositoryError(409,"点评已更新，请重新打开后归档");
  const existing = await getCommentaryPdfArchive(env.DB,id,expectedVersion);
  if (existing) return existing;
  if (!commentary.commentary.trim()) throw new PolicyRepositoryError(422,"请先完成点评正文");
  const bytes = uploadedBytes ?? renderCommentaryPdf(commentary), key = commentaryPdfKey(commentary);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),b=>b.toString(16).padStart(2,"0")).join("");
  const fileName = `${commentary.commentaryDate || "日期未注明"}-${commentary.eventName.replace(/[\\/\x00-\x1f]/g," ")}.pdf`;
  const now = new Date().toISOString();
  const object = await env.EASTMONEY.put(key, bytes, { httpMetadata:{contentType:"application/pdf",cacheControl:"private, no-store"},
    customMetadata:{commentaryId:id,revisionAt:expectedVersion,sha256}, onlyIf: { etagDoesNotMatch: "*" } });
  let archivedHash=sha256, archivedSize=bytes.length;
  if (!object) {
    const winner=await env.EASTMONEY.head(key);
    if (!winner?.customMetadata?.sha256) throw new PolicyRepositoryError(409,"该版本归档正在处理中，请重试");
    archivedHash=winner.customMetadata.sha256; archivedSize=winner.size;
  }
  await env.DB.prepare(`INSERT INTO commentary_pdf(commentary_id,revision_at,r2_key,file_name,sha256,byte_size,archived_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(commentary_id,revision_at) DO NOTHING`).bind(id,expectedVersion,key,fileName,archivedHash,archivedSize,now).run();
  return (await getCommentaryPdfArchive(env.DB,id,expectedVersion))!;
}
export async function downloadCommentaryPdf(env: Env, id: string, revisionAt?: string): Promise<Response> {
  if (!env.EASTMONEY) throw new PolicyRepositoryError(503,"PDF 归档存储尚未配置");
  const commentary = await getCommentary(env.DB,id);
  const archive = await getCommentaryPdfArchive(env.DB,id,revisionAt ?? commentary.updatedAt);
  if (!archive) throw new PolicyRepositoryError(404,"当前点评版本尚未归档 PDF");
  // Object keys come only from the archive table, never a user-supplied bucket path.
  if (!archive.key.startsWith("research-commentary/")) throw new PolicyRepositoryError(500,"PDF 归档路径无效");
  const object = await env.EASTMONEY.get(archive.key);
  if (!object) throw new PolicyRepositoryError(404,"PDF 归档文件不存在");
  return new Response(object.body,{headers:{"Content-Type":"application/pdf","Cache-Control":"private, no-store",
    "Content-Disposition":`attachment; filename="commentary.pdf"; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
    "X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox",ETag:object.httpEtag}});
}


export async function readUploadedCommentaryPdf(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const limit = 16 * 1024 * 1024;
  const declared = Number(request.headers.get("content-length"));
  if (declared > limit) throw new PolicyRepositoryError(413,"PDF 超过16MB，请减少篇幅后重试");
  if (!request.body) throw new PolicyRepositoryError(400,"PDF 文件为空");
  const reader=request.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  while(true) {
    const {value,done}=await reader.read();if(done)break;
    size+=value.length;if(size>limit){await reader.cancel();throw new PolicyRepositoryError(413,"PDF 超过16MB");}chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const decoder=new TextDecoder();
  if(decoder.decode(bytes.slice(0,5))!=="%PDF-" || !decoder.decode(bytes.slice(-64)).includes("%%EOF"))throw new PolicyRepositoryError(400,"PDF 文件格式无效");
  return bytes;
}
