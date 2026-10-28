import { parseBondLedgerFile } from "./parser";

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try { self.postMessage({ parsed: await parseBondLedgerFile(data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "台账解析失败" }); }
};
