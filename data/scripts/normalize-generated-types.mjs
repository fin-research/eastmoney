import { readFileSync, writeFileSync } from "node:fs";

const path = "worker-configuration.d.ts";
const source = readFileSync(path, "utf8");
const normalized = `${source.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
if (normalized !== source) writeFileSync(path, normalized);
