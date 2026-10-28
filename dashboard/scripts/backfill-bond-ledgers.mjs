import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { parseBondLedgerBuffer } from "../src/lib/bond-ledger/parser.ts";
import { persistParsedBondLedger } from "../src/lib/server/bond-ledger-repository.ts";

const apply = process.argv.includes("--apply");
const sourceArgument = process.argv.find((argument) =>
  argument.startsWith("--source-base-url="),
);
const sourceBaseUrl = (
  sourceArgument?.slice("--source-base-url=".length) ||
  "https://eastmoney.hasbai.xyz"
).replace(/\/$/, "");
const inventoryResponse = await fetch(`${sourceBaseUrl}/api/bond-ledger`);
if (!inventoryResponse.ok) {
  throw new Error(`Source inventory failed: HTTP ${inventoryResponse.status}`);
}
const inventory = await inventoryResponse.json();
const files = Array.isArray(inventory?.files)
  ? [...inventory.files].sort((left, right) => left.date.localeCompare(right.date))
  : [];
if (!files.length) throw new Error("Source inventory does not contain ledgers");

const parsedFiles = [];
for (const file of files) {
  const response = await fetch(
    `${sourceBaseUrl}/api/bond-ledger?date=${encodeURIComponent(file.date)}`,
  );
  if (!response.ok) {
    throw new Error(`${file.date} download failed: HTTP ${response.status}`);
  }
  const parsed = await parseBondLedgerBuffer(await response.arrayBuffer());
  if (parsed.date !== file.date) {
    throw new Error(`${file.date} source workbook reports ${parsed.date}`);
  }
  parsedFiles.push({ file, parsed });
}

if (!apply) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        sourceBaseUrl,
        files: parsedFiles.map(({ file, parsed }) => ({
          date: file.date,
          statistics: parsed.performance.length,
          positions: parsed.positions.length,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required with --apply");
const client = new Client({
  connectionString,
  application_name: "eastmoney-bond-backfill",
});
const results = [];
try {
  await client.connect();
  for (const { file, parsed } of parsedFiles) {
    const uploadId = randomUUID();
    results.push(
      await persistParsedBondLedger(client, {
        uploadId,
        workflowInstanceId: `backfill-${uploadId}`,
        r2Key: file.key,
        r2Etag: file.etag || null,
        originalName: file.fileName,
        fileSize: file.size,
        expectedDate: file.date,
        uploadedAt: file.uploadedAt,
        parsed,
      }),
    );
  }
} finally {
  await client.end().catch(() => undefined);
}

console.log(JSON.stringify({ mode: "apply", imported: results }, null, 2));
