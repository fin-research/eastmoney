import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { entry, service, hash } from './report-patch.mjs';

export const schedulerEntry = entry.replace("export default original;", "export { ScheduledTasks } from './scheduler-service.js';\nexport default original;");
export const schedulerService = `import { WorkerEntrypoint } from 'cloudflare:workers';\nimport { scheduledTasks } from './scheduled-tasks.js';\nexport class ScheduledTasks extends WorkerEntrypoint { fetch(request) { return scheduledTasks(request,this.env); } }\n`;

export async function schedulerModules() {
  return {
    'scheduler-service.js': Buffer.from(schedulerService),
    'scheduled-tasks.js': Buffer.from(stripTypeScriptTypes(await readFile(new URL('./scheduled-tasks.ts', import.meta.url), 'utf8')).replace("'./scheduled.ts'", "'./scheduled.js'")),
    'scheduled.js': Buffer.from(stripTypeScriptTypes(await readFile(new URL('./scheduled.ts', import.meta.url), 'utf8'))),
  };
}

/** Reject drift before changing only the reviewed entry wrapper. */
export function reviewSchedulerBaseline(entrypoint, modules, reportModule, addedModules) {
  const names = Object.keys(modules).sort();
  const base = ['entry.js', 'production.js', 'research-report.mjs', 'research-service.js'];
  const installed = names.length === 7;
  const expected = installed ? [...base, ...Object.keys(addedModules)].sort() : base;
  if (entrypoint !== 'entry.js' || JSON.stringify(names) !== JSON.stringify(expected)
    || modules['entry.js'].toString() !== (installed ? schedulerEntry : entry)
    || modules['research-service.js'].toString() !== service
    || !modules['research-report.mjs'].equals(reportModule)
    || !modules['production.js'].toString().includes('BondInferenceWorkflow')) throw new Error('Unexpected production scheduler layout');
  if (installed && Object.entries(addedModules).some(([name, bytes]) => hash(bytes) !== hash(modules[name]))) throw new Error('Installed scheduler code differs');
  return installed;
}
