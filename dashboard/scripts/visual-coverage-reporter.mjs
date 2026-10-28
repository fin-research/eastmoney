import { mkdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { readJson, validateManifest, validateExecution } from './visual-coverage.mjs';

// Gate the full CI run, not developer --grep/--project investigations.
export default class VisualCoverageReporter {
  records = [];
  onBegin(config) {
    this.enabled = process.env.VISUAL_COVERAGE_GATE === '1';
    if (!this.enabled) return;
    this.manifest = readJson('visual-coverage.json');
    try {
      this.summary = validateManifest(this.manifest, process.cwd(), { allowMissingBaselines: config.updateSnapshots === 'all' });
    } catch (error) { this.error = error.message; }
  }
  onTestEnd(test, result) {
    if (!this.enabled) return;
    this.records.push({ spec: relative(process.cwd(), test.location.file).replaceAll('\\', '/'), title: test.title,
      project: test.parent.project().name, status: result.status, steps: result.steps });
  }
  onEnd() {
    if (!this.enabled) return;
    try {
      if (this.error) throw new Error(this.error);
      validateExecution(this.manifest, this.records);
    } catch (error) { this.error = error.message; }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/visual-coverage.json', JSON.stringify({ ...this.summary, error: this.error ?? null,
      scenarios: this.manifest.scenarios, pages: this.manifest.pages }, null, 2) + '\n');
    if (this.error) { console.error(this.error); return { status: 'failed' }; }
    console.log(`Visual inventory: ${this.summary.pages} page modules; ${this.summary.screenshot} screenshot, ${this.summary.interaction} interaction, ${this.summary.deferred} deferred scenarios; ${this.summary.exemptPages} page exemptions.`);
  }
}
