import { error,json } from '@sveltejs/kit';
import { readProgress, writeProgress, progressPatch } from '$lib/server/trading-progress';
import { shanghaiClock } from '$lib/trading-workflow/model';
import { requireSameOrigin } from '$lib/server/dashboard-access';
import type { RequestHandler } from './$types';
const headers={'Cache-Control':'no-store, private'};
export const GET:RequestHandler=async({locals,platform})=>{if(!locals.user)error(401,'请先登录');return json(await readProgress(platform!.env.DB,locals.user.id,shanghaiClock().date),{headers});};
export const PUT:RequestHandler=async({locals,platform,request})=>{
 requireSameOrigin(request);if(!locals.user)error(401,'请先登录');
 const text=await request.text();if(text.length>40000)error(413,'进度内容过大');
 let raw;try{raw=JSON.parse(text);}catch{error(400,'JSON 无效');}
 const parsed=progressPatch.safeParse(raw);if(!parsed.success||parsed.data.date!==shanghaiClock().date)error(400,'只能更新当日进度');
 return json(await writeProgress(platform!.env.DB,locals.user.id,parsed.data),{headers});
};
