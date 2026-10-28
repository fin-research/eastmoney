import { error } from '@sveltejs/kit';
import { requireSameOrigin } from './dashboard-access';
import type { RequestEvent } from '@sveltejs/kit';
export function notificationCategories(user:App.Locals['user']) {
 const permissions=user?.authorization?.permissions ?? [];
 return [...(user?.authorization?.roles.some(role=>role.name==='admin') ? ['workflow'] : []),
 ...(permissions.includes('research.workspace:read')?['trading']:[]),...(permissions.includes('financing.project:read')?['financing']:[])];
}
export async function notificationRequest(event:RequestEvent,path:string,method='GET',body?:unknown) {
 if(!event.locals.user?.auth0Id)error(401,'请先登录');
 if(method!=='GET')requireSameOrigin(event.request);
 const binding=event.platform?.env.MESSENGER_ADMIN;
 if(!binding)error(503,'通知服务暂不可用');
 const response=await binding.fetch(new Request(`https://messenger.internal/users/${encodeURIComponent(event.locals.user.auth0Id)}${path}`,{
 method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
 const value=await response.json() as Record<string,unknown>;
 if(!response.ok)error(response.status>=500?503:response.status,{message:String(value.error ?? '通知设置失败')});
 return value;
}
export async function boundedJson(request:Request) {const body=await request.text();if(body.length>20000)error(413,'内容过大');try{return JSON.parse(body);}catch{error(400,'JSON 无效');}}
