import { error, json } from '@sveltejs/kit';
import { notificationRequest, boundedJson } from '$lib/server/notification-settings';
import type { RequestHandler } from './$types';
export const POST:RequestHandler=async event=>json(await notificationRequest(event,'/push','POST',await boundedJson(event.request)),{headers:{'Cache-Control':'no-store, private'}});
export const DELETE:RequestHandler=async event=>{
 const value=await boundedJson(event.request);
 if(typeof value.id!=='string'||!/^[0-9a-f-]{36}$/.test(value.id))error(400,'设备编号无效');
 return json(await notificationRequest(event,`/push/${value.id}`,'DELETE'));
};
