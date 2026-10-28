// Package the single reviewed README; never expose model or raw input directories.
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.env.QUANT_REPORT_PYTHON ?? 'python3', ['scripts/build_report.py', '--check'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(new URL('./public/', import.meta.url), { recursive: true });
await rm(new URL('./public/REPORT.html', import.meta.url), {force:true});
await copyFile(new URL('../README.md', import.meta.url), new URL('./public/README.md', import.meta.url));
