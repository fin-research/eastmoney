import { readJson, validateManifest } from './visual-coverage.mjs';
const summary = validateManifest(readJson('visual-coverage.json'), process.cwd(), {
  allowMissingBaselines: process.argv.includes('--candidate'),
});
console.log(JSON.stringify(summary, null, 2));
