import { prepareArchive, archiveZip } from './prepare';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerPort = new Worker(pdfWorker,{type:'module'});
self.onmessage = async ({data}: MessageEvent<{file?: File; batch?: Parameters<typeof archiveZip>[0]}>) => {
  try {
    if (data.batch) { self.postMessage({zip:archiveZip(data.batch)}); return; }
    const batch = await prepareArchive(new Uint8Array(await data.file!.arrayBuffer()), async bytes => {
      const loading = getDocument({data:bytes, useSystemFonts:true});
      const document = await loading.promise;
      try {
        const pages = [];
        for (let n=1;n<=document.numPages;n++) {
          const content = await (await document.getPage(n)).getTextContent();
          pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join(''));
        }
        return pages.join('\n');
      } finally { await loading.destroy(); }
    });
    self.postMessage({batch});
  } catch(error) { self.postMessage({error:error instanceof Error ? error.message : '文件处理失败'}); }
};
