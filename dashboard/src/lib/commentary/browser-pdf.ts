import { toCanvas } from "html-to-image";

/** Wrap already rendered JPEG pages in A4 PDF pages; no fonts or third-party runtime on the server. */
export function jpegPagesToPdf(pages: Array<{bytes:Uint8Array;width:number;height:number}>): Uint8Array<ArrayBuffer> {
  const encoder=new TextEncoder(), objects:Uint8Array[]=[];
  const enc=(value:string)=>encoder.encode(value);
  const join=(parts:Uint8Array[])=>{const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;};
  const add=(value:Uint8Array|string)=>{objects.push(typeof value==='string'?enc(value):value);return objects.length;};
  const catalog=add(''), tree=add(''), ids:number[]=[];
  for(const page of pages) {
    const image=add(join([enc(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),page.bytes,enc('\nendstream')]));
    const height=page.height/page.width*523.28;
    const command=`q 523.28 0 0 ${height.toFixed(3)} 36 ${(805.89-height).toFixed(3)} cm /Im0 Do Q`;
    const stream=add(`<< /Length ${command.length} >>\nstream\n${command}\nendstream`);
    ids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog-1]=enc(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  objects[tree-1]=enc(`<< /Type /Pages /Kids [${ids.map(id=>`${id} 0 R`).join(' ')}] /Count ${ids.length} >>`);
  const parts=[enc('%PDF-1.7\n')], offsets=[0];let offset=parts[0]!.length;
  for(let index=0;index<objects.length;index++) { offsets.push(offset);const object=join([enc(`${index+1} 0 obj\n`),objects[index]!,enc('\nendobj\n')]);parts.push(object);offset+=object.length; }
  parts.push(enc(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return join(parts);
}

/** Capture the same report used for printing. Pages break between text lines, never across a glyph. */
export async function captureCommentaryPdf(report: HTMLElement): Promise<Uint8Array<ArrayBuffer>> {
  await document.fonts.ready;
  const rect=report.getBoundingClientRect();
  if(!rect.width || !rect.height)throw new Error('报告尚未完成排版');
  const lines:Array<{top:number;bottom:number}>=[];
  const walker=document.createTreeWalker(report,NodeFilter.SHOW_TEXT);
  let node:Node|null;
  while((node=walker.nextNode())) {
    if(!node.textContent?.trim())continue;
    const range=document.createRange();range.selectNodeContents(node);
    for(const line of range.getClientRects())if(line.height>0)lines.push({top:line.top-rect.top,bottom:line.bottom-rect.top});
  }
  const pageHeight=(769.89/523.28)*rect.width;
  const pages:Array<{bytes:Uint8Array;width:number;height:number}>=[];
  let start=0;
  while(start<rect.height) {
    let end=Math.min(start+pageHeight,rect.height);
    if(end<rect.height) {
      let prior=-1;
      while(prior!==end) { prior=end;for(const line of lines)if(line.top<end && line.bottom>end)end=Math.max(start,line.top-1); }
    }
    if(end<=start+1)throw new Error('报告段落超出 A4 可用高度');
    const height=Math.ceil(end-start);
    const page=await toCanvas(report,{pixelRatio:3,backgroundColor:'#ffffff',width:rect.width,height,
      skipFonts:true, style:{width:`${rect.width}px`,height:`${rect.height}px`,transform:`translateY(-${start}px)`,transformOrigin:'top left'}});
    const base64=page.toDataURL('image/jpeg',0.96).split(',')[1]!;
    pages.push({bytes:Uint8Array.from(atob(base64),char=>char.charCodeAt(0)),width:page.width,height:page.height});
    start=end;
  }
  return jpegPagesToPdf(pages);
}

export function downloadPdfBlob(blob: Blob, fileName: string) {
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
