// Recognize only the reviewed first-publish and repeat-publish module layouts.
import { createHash } from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const entry = `export { BondInferenceWorkflow } from './production.js';\nexport { ResearchReport } from './research-service.js';\nimport original from './production.js';\nexport default original;\n`;
export const service = `import { WorkerEntrypoint } from 'cloudflare:workers';\nimport { serveResearchReport } from './research-report.mjs';\nexport class ResearchReport extends WorkerEntrypoint { fetch(request) { return serveResearchReport(request,this.env.ASSETS); } }\n`;

export function reviewedModules(entrypoint, modules, reportModule, scheduler) {
  const names = Object.keys(modules).sort();
  const scheduled = names.length === 7 && Boolean(scheduler);
  const wrapped = names.length === 4 || scheduled;
  if (wrapped) {
    const expectedNames = ['entry.js', 'production.js', 'research-report.mjs', 'research-service.js', ...(scheduled ? Object.keys(scheduler.modules) : [])].sort();
    if (entrypoint !== 'entry.js' || JSON.stringify(names) !== JSON.stringify(expectedNames)
      || modules['entry.js'].toString() !== (scheduled ? scheduler.entry : entry) || modules['research-service.js'].toString() !== service
      || (scheduled && Object.entries(scheduler.modules).some(([name, bytes]) => !modules[name].equals(bytes)))
      || !modules['research-report.mjs'].equals(reportModule)) throw new Error('Report wrapper layout changed; inspect production before repackaging');
  } else if (names.length !== 1 || names[0] !== entrypoint) {
    throw new Error('Unexpected production module layout');
  }
  const original = modules[wrapped ? 'production.js' : entrypoint];
  if (!original.toString().includes('BondInferenceWorkflow') || original.toString().includes('ResearchReport')) throw new Error('Unexpected production exports');
  return {
    wrapped,
    production: original,
    runtime: wrapped ? modules : {
      'production.js': original, 'entry.js': Buffer.from(entry),
      'research-service.js': Buffer.from(service), 'research-report.mjs': reportModule,
    },
  };
}

export function moduleHashes(modules) {
  return Object.fromEntries(Object.keys(modules).sort().map(name => [name, hash(modules[name])]));
}
