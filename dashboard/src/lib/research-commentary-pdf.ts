import type { CommentaryDraft } from "./commentary.ts";
import { commentaryTypeLabels } from "./commentary.ts";

/** A4 text PDF with the PDF-standard Simplified Chinese CID font/CMap.
 * All text is UTF-16BE hex, never interpolated as PDF operators. Original PDFs
 * are archived byte-for-byte; this renderer is for new structured drafts only.
 */
export function renderCommentaryPdf(draft: CommentaryDraft): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(""), pages = add("");
  const descriptor = add("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>");
  const cid = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const unicode = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cid} 0 R] /ToUnicode ${unicode} 0 R >>`);
  const pageIds: number[] = []; let commands: string[] = [], y = 800;
  function finish() {
    const stream = commands.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    commands = []; y = 800;
  }
  function hex(text: string) {
    return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index).toString(16).padStart(4,"0")).join("");
  }
  function line(text: string, size: number, gap = 0) {
    if (y - size - gap < 42) finish();
    commands.push(`BT /F1 ${size} Tf 0.09 0.13 0.20 rg 1 0 0 1 42 ${y.toFixed(2)} Tm <${hex(text)}> Tj ET`);
    y -= size * 1.48 + gap;
  }
  function text(value: string, size = 10.5, gap = 0) {
    const limit = 510 / size;
    for (const paragraph of value.replaceAll("\r\n","\n").split("\n")) {
      if (!paragraph) { y -= 5; continue; }
      // Conservative full-width wrapping also covers non-ASCII symbols safely.
      let current = "", width = 0;
      for (const character of paragraph) {
        const units = 1;
        if (width + units > limit) { line(current,size); current = ""; width = 0; }
        current += character; width += units;
      }
      if (current) line(current,size,gap);
    }
  }
  text(`【东财证券】资金管理部：${commentaryTypeLabels[draft.type]}`, 15, 10);
  text(`事件名称：${draft.eventName}`, 11, 3);
  text(`消息来源：${draft.sources || "未注明"}`);
  text(`发布时间：${draft.eventPublishedAt || "未注明"}    快评时间：${draft.commentaryDate || "未注明"}`);
  y -= 6; commands.push(`0.18 0.44 0.84 RG 1 w 42 ${y.toFixed(2)} m 553 ${y.toFixed(2)} l S`); y -= 22;
  for (const [heading, body] of [["事件摘要",draft.eventSummary],["时事快评",draft.commentary],["应对建议",draft.recommendation]]) {
    if (!body) continue;
    if (y < 100) finish();
    text(`【${heading}】`,12,4); text(body,10.5,2); y -= 8;
  }
  if (commands.length) finish();
  objects[catalog-1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages-1] = `<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.7\n"; const offsets = [0];
  for (let index=0; index<objects.length; index++) { offsets.push(pdf.length); pdf += `${index+1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10,"0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function commentaryPdfKey(value: { id: string; type: CommentaryDraft["type"]; updatedAt: string }): string {
  const id = encodeURIComponent(value.id), version = encodeURIComponent(value.updatedAt);
  return `research-commentary/${commentaryTypeLabels[value.type]}/${id}/${version}.pdf`;
}
