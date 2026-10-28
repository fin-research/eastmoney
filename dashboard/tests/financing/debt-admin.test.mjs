import test from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { PGlite } from '@electric-sql/pglite';
import ExcelJS from 'exceljs';
import {readFile} from 'node:fs/promises';
const {compileDataAdminQuery} = await tsImport('../../src/lib/server/financing/data-admin-query.ts',import.meta.url);
const {DEBT_ENTITIES,DATA_ADMIN_TABS,debtEditorPayload} = await tsImport('../../src/lib/financing/data-admin.ts',import.meta.url);
const {populateDebtWorkbook} = await tsImport('../../src/lib/financing/debt-export.ts',import.meta.url);

test('actual debt SQL excludes maturity today, early settlement and closure; retains future and undated planned debt',async()=>{
 const db=new PGlite();
 try {
 await db.exec('CREATE SCHEMA financing; CREATE ROLE authenticated;');
 const migration=await readFile(new URL('../../financing-migrations/0036_debt_live_status.sql',import.meta.url),'utf8');
 await db.exec(migration.slice(migration.indexOf('CREATE FUNCTION'),migration.indexOf('CREATE OR REPLACE VIEW')));
 const config=DEBT_ENTITIES.find(entity=>entity.tableName==='bond');
 const columns=new Map(config.fields.map(field=>[field.key,field.type==='date'?'date':field.key==='id'?'bigint':field.type==='number'?'numeric':'text']));
 for(const key of Object.keys(config.fixedValues))columns.set(key,'text');
 await db.exec(`CREATE TABLE financing.bond(${[...columns].map(([key,type])=>`"${key}" ${type}`).join(',')})`);
 await db.exec(`INSERT INTO financing.bond(id,name,debt_type,subtype,issue_date,maturity_date,settled_at,closed_at) VALUES
 (1,'yesterday','债券','小公募','2026-01-01','2026-10-15',null,null),
 (2,'today','债券','小公募','2026-01-01','2026-10-16',null,null),
 (3,'tomorrow','债券','小公募','2026-01-01','2026-10-17',null,null),
 (4,'planned','债券','小公募','2026-01-01',null,null,null),
 (5,'settled','债券','小公募','2026-01-01','2027-01-01','2026-10-16',null),
 (6,'closed','债券','小公募','2026-01-01','2027-01-01',null,'2026-10-15'),
 (7,'other product','债券','次级债','2026-01-01','2027-01-01',null,null)`);
 const params=new URLSearchParams({select:'id,name',debt_type:'eq.债券',subtype:'eq.小公募',lifecycle:'unmatured',as_of:'2026-10-16',order:'issue_date.desc.nullslast,id.desc.nullslast'});
 const query=compileDataAdminQuery('bond','GET',params);
 assert.deepEqual((await db.query(query.sql,query.values)).rows.map(x=>x.row.name),['planned','tomorrow']);
 assert.equal(Number((await db.query(query.countSql,query.countValues)).rows[0].total),2);
 await db.exec(`UPDATE financing.bond SET amount=id*100, annual_rate=id*0.01`);
 const filtered=new URLSearchParams(params);filtered.set('filter_amount',JSON.stringify({min:'300',max:'300'}));filtered.set('filter_annual_rate',JSON.stringify({min:'3',max:'3'}));
 const range=compileDataAdminQuery('bond','GET',filtered);assert.deepEqual((await db.query(range.sql,range.values)).rows.map(x=>x.row.name),['tomorrow']);
 filtered.set('filter_amount',JSON.stringify({min:'100); DROP TABLE financing.bond'}));assert.throws(()=>compileDataAdminQuery('bond','GET',filtered),/数值/);
 params.set('issue_from','2026-02-01');const empty=compileDataAdminQuery('bond','GET',params);assert.equal((await db.query(empty.sql,empty.values)).rows.length,0);
 assert.throws(()=>compileDataAdminQuery('bond','GET',new URLSearchParams({lifecycle:'unmatured',as_of:'2026-02-30'})),/日期/);
 assert.throws(()=>compileDataAdminQuery('bond','PATCH',params,{name:'x'}),/筛选/);
 } finally {await db.close();}
});

test('shared editor converts rates, omits generated fields, validates bounds and fixes refinancing name',()=>{
 const cert=DEBT_ENTITIES[0];
 const values={name:'收益凭证',subtype:'固定收益凭证',amount:'1000',annual_rate:'2.5',status:'closed',id:1};
 const payload=debtEditorPayload(cert,'create',values);
 assert.equal(payload.annual_rate,.025);assert.equal(payload.amount,1000);assert.equal(payload.status,undefined);assert.equal(payload.id,undefined);
 assert.throws(()=>debtEditorPayload(cert,'create',{...values,amount:'-1'}),/范围/);
 assert.equal(debtEditorPayload(DEBT_ENTITIES.find(e=>e.tableName==='refinancing'),'create',{amount:'1'}).name,'转融资');
});

test('Excel roundtrip preserves dates, amounts and displayed percentage as real numeric cells',async()=>{
 const workbook=new ExcelJS.Workbook();const config=DEBT_ENTITIES[0];
 populateDebtWorkbook(workbook,config,[{id:42,name:'凭证',amount:'120000.25',annual_rate:0.021,issue_date:'2026-10-16',subtype:'固定收益凭证'}]);
 const reread=new ExcelJS.Workbook();await reread.xlsx.load(await workbook.xlsx.writeBuffer());
 const fields=config.fields.filter(f=>!['created_at','updated_at'].includes(f.key));const cell=key=>reread.worksheets[0].getRow(2).getCell(fields.findIndex(f=>f.key===key)+1).value;
 assert.equal(cell('amount'),120000.25);assert.equal(cell('annual_rate'),2.1);assert.equal(cell('issue_date').toISOString(),'2026-10-16T00:00:00.000Z');
});

test('migration status function and preserved overview use Shanghai current date and lifecycle priority',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE SCHEMA financing; CREATE ROLE authenticated;');
  const migration=await readFile(new URL('../../financing-migrations/0036_debt_live_status.sql',import.meta.url),'utf8');
  await db.exec(migration.slice(migration.indexOf('CREATE FUNCTION'),migration.indexOf('CREATE OR REPLACE VIEW')));
  const rows=[
   ['2026-01-01','2026-10-15',null,null,null,'matured'],
   ['2026-01-01','2026-10-16',null,null,null,'matured'],
   ['2026-01-01','2026-10-17',null,null,null,'active'],
   ['2026-10-17','2027-01-01',null,null,null,'planned'],
   ['2026-01-01','2027-01-01','2026-10-17',null,null,'planned'],
   [null,null,null,null,null,'planned'],
   ['2026-01-01',null,null,null,null,'active'],
   ['2026-01-01','2027-01-01',null,'2026-10-16',null,'matured'],
   ['2026-01-01','2026-10-15',null,'2026-10-16','2026-10-16','closed'],
   ['2026-01-01','2027-01-01',null,'2026-10-17','2026-10-17','active']
  ];
  for(const [issue,maturity,activation,settled,closed,expected] of rows){const result=await db.query('SELECT financing.debt_status_as_of($1,$2,$3,$4,$5,$6) status',[issue,maturity,activation,settled,closed,'2026-10-16']);assert.equal(result.rows[0].status,expected);}
  await db.exec(`CREATE TABLE financing.debt(id bigint,debt_type text,subtype text,name text,counterparty text,amount numeric,interest_payable numeric,total_amount numeric,annual_rate numeric,issue_date date,maturity_date date,term_days int,activated_at date,settled_at date,closed_at date,status text,created_at timestamptz,updated_at timestamptz,client_id bigint); CREATE VIEW financing.debt_overview AS SELECT d.id,d.debt_type,d.subtype,d.name,d.counterparty,d.amount,d.interest_payable,d.total_amount,d.annual_rate,d.issue_date,d.maturity_date,d.term_days,d.activated_at,d.settled_at,d.closed_at,d.status,d.created_at,d.updated_at,COALESCE(NULLIF(d.subtype,''),d.debt_type) AS reporting_type,d.client_id FROM financing.debt d; DROP FUNCTION financing.debt_status_as_of(date,date,date,date,date,date);`);
  await db.exec(migration);
  await db.exec(`INSERT INTO financing.debt(id,issue_date,maturity_date,status) VALUES (1,'2000-01-01','2001-01-01','active')`);
  assert.equal((await db.query('SELECT status FROM financing.debt_overview')).rows[0].status,'matured');
  assert.match(migration,/CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(migration,/SECURITY INVOKER/);
 }finally{await db.close();}
});


test('debt tabs hide inactive categories without changing existing entity URLs',()=>{
 assert.deepEqual(DATA_ADMIN_TABS.map(tab=>tab.label),['数据管理','收益凭证','小公募','次级债','短期融资券','转融资','集团借款','同业拆借']);
 assert.equal(DEBT_ENTITIES.find(entity=>entity.key==='debt-1').label,'小公募');
 assert.equal(DATA_ADMIN_TABS.find(tab=>tab.label==='短期融资券').id,'debt-5');
});
