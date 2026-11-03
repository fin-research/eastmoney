// Package the single reviewed README; never expose model or raw input directories.
import { mkdir, copyFile, rm } from 'node:fs/promises';

await mkdir(new URL('./public/', import.meta.url), { recursive: true });
await rm(new URL('./public/REPORT.html', import.meta.url), {force:true});
await copyFile(new URL('../README.md', import.meta.url), new URL('./public/README.md', import.meta.url));
