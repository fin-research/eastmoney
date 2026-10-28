import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrations = new URL('../financing-model-migrations/', import.meta.url);
const oldId = '00000000-0000-4000-8000-000000000001';
const latestId = '00000000-0000-4000-8000-000000000002';

async function prepare() {
  const db = new PGlite();
  for (const file of (await readdir(migrations)).sort().filter(name => name < '0005')) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
  // Seed all mandatory scalar columns against the real schema, using synthetic data.
  const { rows: columns } = await db.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='financing_model' AND table_name='model_run'
    AND is_nullable='NO' AND column_default IS NULL ORDER BY ordinal_position`);
  for (const [id, hour] of [[oldId, '01'], [latestId, '02']]) {
    const values = columns.map(({ column_name: name, data_type: type }) => {
      if (name === 'id') return id;
      if (name === 'recommendation') return 'wait';
      if (name === 'historical_percentile') return 52;
      if (type === 'date') return '2026-09-11';
      if (type === 'timestamp with time zone') return `2026-09-11T${hour}:00:00Z`;
      if (type === 'ARRAY') return [];
      if (type === 'boolean') return false;
      if (type === 'text') return '测试';
      return 1;
    });
    await db.query(`INSERT INTO financing_model.model_run (${columns.map(c => c.column_name).join(',')})
      VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`, values);
  }
  await db.query(`UPDATE financing_model.model_run SET conclusion_verdict='人工建议',
    conclusion_narrative='人工正文', conclusion_updated_at=now() WHERE id=$1`, [oldId]);
  await db.query(`INSERT INTO financing_model.timing_decision_record (id,run_id,decision_action,outcome)
    VALUES (gen_random_uuid(),$1,'等待询价','已记录')`, [oldId]);
  await db.query(`INSERT INTO financing_model.sell_side_snapshot
    (id,run_id,period_start,period_end,search_query,model_name,payload)
    VALUES (gen_random_uuid(),$1,'2026-09-05','2026-09-11','测试','测试','{}')`, [oldId]);
  return db;
}

const apply = async (db, name) => db.transaction(async tx => {
  await tx.exec(await readFile(new URL(name, migrations), 'utf8'));
});

test('daily migration keeps latest model and preserves manual content and research references', async () => {
  const db = await prepare();
  try {
    await apply(db, '0005_daily_model_versions.sql');
    await apply(db, '0006_recommendation_terciles.sql');
    const { rows } = await db.query('SELECT * FROM financing_model.model_run');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, latestId);
    assert.equal(rows[0].recommendation_label, '建议等待');
    assert.equal(rows[0].base_conclusion_verdict, '建议等待');
    assert.equal(rows[0].conclusion_verdict, '人工建议');
    assert.equal(rows[0].conclusion_narrative, '人工正文');
    for (const table of ['timing_decision_record', 'sell_side_snapshot']) {
      assert.equal((await db.query(`SELECT run_id FROM financing_model.${table}`)).rows[0].run_id, latestId);
    }
    await assert.rejects(db.query(`INSERT INTO financing_model.model_run
      SELECT (jsonb_populate_record(NULL::financing_model.model_run,
      to_jsonb(r) || jsonb_build_object('id', $1::text))).* FROM financing_model.model_run r`, [oldId]), /model_run_as_of_date_key/);
  } finally { await db.close(); }
});

test('daily migration rolls back when a date has multiple independent manual decisions', async () => {
  const db = await prepare();
  try {
    await db.query(`INSERT INTO financing_model.timing_decision_record (id,run_id,decision_action)
      VALUES (gen_random_uuid(),$1,'另一条决策')`, [latestId]);
    await assert.rejects(apply(db, '0005_daily_model_versions.sql'), /require reconciliation/);
    assert.equal((await db.query('SELECT count(*) FROM financing_model.model_run')).rows[0].count, 2);
    assert.equal((await db.query('SELECT count(*) FROM financing_model.timing_decision_record')).rows[0].count, 2);
  } finally { await db.close(); }
});
