import { z } from 'zod';
import { emptyDay } from '../trading-workflow/model.ts';
const flags=z.record(z.string().max(80),z.boolean()).refine(value=>Object.keys(value).length<=150);
export const progressPatch=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),enabled:z.object({loan:z.boolean().optional(),reverse:z.boolean().optional(),exchange:z.boolean().optional()}).strict().optional(),completed:flags.optional(),branches:flags.optional()}).strict();
export async function readProgress(db:Env['DB'],userId:string,date:string){
 const row=await db.prepare('SELECT state,revision FROM trading_workflow_progress WHERE user_id=? AND date=?').bind(userId,date).first<{state:string;revision:number}>();
 return {state:row?JSON.parse(row.state):emptyDay(date),revision:row?.revision??0};
}
export async function writeProgress(db:Env['DB'],userId:string,raw:unknown){
 const patch=progressPatch.parse(raw);
 for(let attempt=0;attempt<5;attempt++){
  const old=await readProgress(db,userId,patch.date);
  const state={...old.state,enabled:{...old.state.enabled,...patch.enabled},completed:{...old.state.completed,...patch.completed},branches:{...old.state.branches,...patch.branches}};
  const result=old.revision===0?await db.prepare('INSERT OR IGNORE INTO trading_workflow_progress(user_id,date,state,updated_at) VALUES(?,?,?,?)').bind(userId,patch.date,JSON.stringify(state),Date.now()).run():await db.prepare('UPDATE trading_workflow_progress SET state=?,revision=revision+1,updated_at=? WHERE user_id=? AND date=? AND revision=?').bind(JSON.stringify(state),Date.now(),userId,patch.date,old.revision).run();
  if(result.meta.changes)return {state,revision:old.revision+1};
 }
 throw new Error('进度保存冲突，请重试');
}
