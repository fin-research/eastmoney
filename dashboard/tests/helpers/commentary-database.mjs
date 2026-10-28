import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function commentaryDatabase({unified=true}={}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE article(id TEXT PRIMARY KEY);');
  for (const name of ['1004_create_policy_tracking.sql','1017_tracking_commentary_workspace.sql','1018_research_commentary_pdf.sql', ...(unified ? ['1021_unify_commentary.sql'] : [])]) sqlite.exec(readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
  const db = {prepare(sql) { return { values:[],bind(...args){this.values=args;return this;},async first(){return sqlite.prepare(sql).get(...this.values) ?? null;},async all(){return {results:sqlite.prepare(sql).all(...this.values)};},async run(){const r=sqlite.prepare(sql).run(...this.values);return {meta:{changes:Number(r.changes)}};} }; },async batch(statements){sqlite.exec('BEGIN');try {const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {db,sqlite};
}
