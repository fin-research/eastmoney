import fs from 'node:fs';
import { Client } from 'pg';
import { z } from 'zod';

const inputPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
if (!inputPath) throw new Error('用法：node scripts/maintain-clients.mjs <客户清单.json> [--apply]；默认事务回滚预览');
const name = z.string().trim().min(1).max(500);
const schema = z.object({
  clients: z.array(z.object({ name, fullname: name.nullable(), type: z.enum(['银行','理财子','券商','基金','营业部客户','其它']), subtype: name.nullable() })),
  aliases: z.array(z.object({ alias: name, clientName: name }).strict()),
  creditMappings: z.array(z.object({ institutionName: name, clientName: name, notes: name }).strict())
});
const manifest = schema.parse(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
const clientNames = new Set(manifest.clients.map(c => c.name));
if (clientNames.size !== manifest.clients.length) throw new Error('客户简称重复');
for (const item of [...manifest.aliases, ...manifest.creditMappings]) {
  if (!clientNames.has(item.clientName)) throw new Error(`关联客户未在清单中定义：${item.clientName}`);
}
const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000, application_name: 'eastmoney-client-maintenance' });
await database.connect();
try {
  await database.query('BEGIN');
  await database.query("SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'))");
  await database.query("SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import', 0))");
  await database.query(`INSERT INTO public.client (name,fullname,type,subtype)
    SELECT name,fullname,type,subtype FROM jsonb_to_recordset($1::jsonb) AS x(name text,fullname text,type text,subtype text)
    ON CONFLICT(name) DO UPDATE SET fullname=EXCLUDED.fullname,type=EXCLUDED.type,subtype=EXCLUDED.subtype`, [JSON.stringify(manifest.clients)]);
  // An explicit override back to a generic result removes the old exception.
  await database.query(`DELETE FROM public.client_alias a
    USING jsonb_to_recordset($1::jsonb) AS x(alias text,"clientName" text),public.client c
    WHERE c.name=x."clientName" AND a.alias=public.client_match_key(x.alias)
      AND public.resolve_client_by_rules(x.alias)=c.id`, [JSON.stringify(manifest.aliases)]);
  await database.query(`INSERT INTO public.client_alias(alias,client_id)
    SELECT public.client_match_key(x.alias),c.id
    FROM jsonb_to_recordset($1::jsonb) AS x(alias text,"clientName" text)
    JOIN public.client c ON c.name=x."clientName"
    WHERE public.resolve_client_by_rules(x.alias) IS DISTINCT FROM c.id
    ON CONFLICT(alias) DO UPDATE SET client_id=EXCLUDED.client_id`, [JSON.stringify(manifest.aliases)]);
  await database.query(`INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes)
    SELECT i.id,x."institutionName",c.id,x.notes
    FROM jsonb_to_recordset($1::jsonb) AS x("institutionName" text,"clientName" text,notes text)
    JOIN public.client c ON c.name=x."clientName"
    JOIN credit.institution i ON i.name=x."institutionName"
    ON CONFLICT(institution_id,client_id) DO UPDATE SET notes=EXCLUDED.notes`, [JSON.stringify(manifest.creditMappings)]);
  const linked = await database.query(`WITH names AS MATERIALIZED (SELECT counterparty,public.resolve_client(counterparty) AS client_id
      FROM (SELECT DISTINCT counterparty FROM financing.debt WHERE client_id IS NULL) names)
    UPDATE financing.debt d SET client_id=n.client_id FROM names n
    WHERE d.client_id IS NULL AND d.counterparty=n.counterparty AND n.client_id IS NOT NULL`);
  const {rows} = await database.query(`SELECT
    (SELECT count(*) FROM public.client) AS clients,
    (SELECT count(*) FROM public.client_alias) AS client_aliases,
    (SELECT count(*) FROM financing.debt WHERE client_id IS NOT NULL) AS linked_debts,
    (SELECT count(*) FROM financing.debt WHERE client_id IS NULL) AS unlinked_debts,
    (SELECT count(*) FROM credit.institution_client) AS credit_links,
    (SELECT count(*) FROM credit.entry_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) s
      WHERE NOT EXISTS(SELECT 1 FROM credit.institution_client m WHERE m.institution_name=s.institution_name)) AS latest_unlinked`);
  await database.query(process.argv.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'applied' : 'rollback-preview', linkedNow: linked.rowCount, ...rows[0] },null,2));
} catch (error) {
  await database.query('ROLLBACK').catch(() => {});
  throw error;
} finally { await database.end(); }
