import {readFileSync} from 'node:fs';

// Built from the original Dashboard visual report. No runtime source checkout,
// dependency installation, remote stylesheet, font, chart library or API call.
const script=readFileSync(new URL('../assets/market-report.js',import.meta.url),'utf8');
const styles=readFileSync(new URL('../assets/market-report.css',import.meta.url),'utf8');

export function visualHtml(report) {
  const json=JSON.stringify(report).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f6f8fb"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'"><title>${report.report_date} · 资金管理部 • 市场点评</title><style>${styles}</style></head><body><div id="app"></div><script id="market-report-data" type="application/json">${json}</script><script type="module">${script.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
}
