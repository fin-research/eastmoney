import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readProgress,writeProgress} from '../src/lib/server/trading-progress.ts';
import {dueReminders} from '../src/lib/trading-workflow/model.ts';
function storage(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/1019_trading_workflow_progress.sql',import.meta.url),'utf8'));return {close:()=>db.close(),prepare(sql){let values=[];return {bind(...args){values=args;return this;},async first(){return db.prepare(sql).get(...values)??null;},async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};}};}};}
test('progress merges field deltas, isolates users/dates and excludes local inquiry contents',async()=>{
 const db=storage();try{
 await writeProgress(db,'auth0|test',{date:'2026-09-17',completed:{a:true}});
 await Promise.all([writeProgress(db,'auth0|test',{date:'2026-09-17',completed:{b:true}}),writeProgress(db,'auth0|test',{date:'2026-09-17',branches:{branch:true}})]);
 const {state}=await readProgress(db,'auth0|test','2026-09-17');assert.deepEqual(state.completed,{a:true,b:true});assert.equal(state.branches.branch,true);
 assert.equal((await readProgress(db,'auth0|other','2026-09-17')).revision,0);
 assert.equal((await readProgress(db,'auth0|test','2026-09-18')).revision,0);
 await assert.rejects(writeProgress(db,'auth0|test',{date:'2026-09-17',quotes:{a:[]}}));
 const node={id:'a',flowIds:['loan'],nextIds:[],parentId:null,kind:'task',title:'划款',detail:'',startTime:'09:00',endTime:null};
 assert.equal(dueReminders([node],state,new Date('2026-09-17T09:01:00+08:00'),'server').length,0);
 }finally{db.close();}
});
