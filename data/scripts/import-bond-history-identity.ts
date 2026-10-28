import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { bondHistoryIdentityPlan, recordBondHistoryIdentities } from '../src/sync/bond-history-identity.ts';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw Error(`Required ${name}`);
  return args[index + 1]!;
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(arg('--plan')), approved = arg('--review-sha');
if (hash(bytes) !== approved) throw Error('Reviewed identity plan hash mismatch');
const plan = bondHistoryIdentityPlan.parse(JSON.parse(bytes.toString()));
if (hash(await readFile(plan.vendor_mapping_file)) !== plan.vendor_mapping_sha256) throw Error('Vendor mapping hash mismatch');
for (const fact of plan.facts) {
  if (hash(await readFile(fact.official_file)) !== fact.official_file_sha256) throw Error('Official identity evidence hash mismatch');
}
const connectionString = process.env.DATABASE_URL ?? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) throw Error('Database connection is required');
const client = new Client({ connectionString,
  application_name: 'bond-history-identity-import', connectionTimeoutMillis: 20000 });
try {
  await client.connect(); await client.query('BEGIN');
  const result = await recordBondHistoryIdentities(client as never, plan, approved, args.includes('--apply'));
  await client.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ ...result, reviewSha256: approved, sourceCalls: 0, observationWrites: 0 }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {}); throw error;
} finally { await client.end(); }
