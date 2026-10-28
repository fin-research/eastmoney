import { z } from 'zod';
import { readWorkflowConfig } from './trading-workflow.ts';
import { readProgress } from './trading-progress.ts';
import { dueReminders, minutes, shanghaiClock } from '../trading-workflow/model.ts';
import { messengerJson } from './messenger.ts';
import { runScheduledReminderCheck } from './financing/reminder-scheduler.js';
export async function notificationSource(request:Request,env:Env) {
 const path=new URL(request.url).pathname;
 if(path!=='/scan'||request.method!=='POST')return new Response('Not Found',{status:404});
 const parsed=z.object({scheduledTime:z.number(),userIds:z.array(z.string().regex(/^auth0\|[^\s]{1,249}$/))}).safeParse(await request.json());
 if(!parsed.success||Math.abs(Date.now()-parsed.data.scheduledTime)>3600000)return new Response('Invalid schedule',{status:400});
 const body=parsed.data;
 const now=new Date(body.scheduledTime),clock=shanghaiClock(now);
 // Weekends do not create trading tasks. Financing reminders retain their natural-day rules.
 if(![0,6].includes(new Date(now.getTime()+8*3600000).getUTCDay())){
  const config=await readWorkflowConfig(env.DB);
  // Messenger supplies its D1 subscribers; only scan when a node can be due.
  // Include both ends of a period and preserve the five-minute catch-up window.
  const inWindow=config.nodes.some(node=>node.kind==='task'&&[node.startTime,node.endTime].some(time=>
   time!==null&&clock.minutes>=minutes(time)&&clock.minutes-minutes(time)<5));
  const userIds=inWindow?[...new Set(body.userIds)]:[];
  for(const userId of userIds){
   const {state}=await readProgress(env.DB,userId,clock.date);
   for(const due of dueReminders(config.nodes,state,now,'server').filter(d=>clock.minutes-minutes(d.time)<5)){
    await messengerJson(env.MESSENGER,'/notifications',{source:'trading',category:'trading',idempotencyKey:`${userId}/${clock.date}/${due.node.id}/${due.time}`,userIds:[userId],title:`交易流程 · ${due.time}`,text:due.node.title,url:'/trading-research/workflow'});
   }
  }
 }
 // The business repository owns selection; only Messenger owns the timer.
 const result=await runScheduledReminderCheck({scheduledTime:body.scheduledTime,env});
 if(result.statuses.failed)throw new Error('FINANCING_NOTIFICATION_SCAN_FAILED');
 return Response.json({ok:true});
}
