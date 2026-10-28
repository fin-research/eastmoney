import { error, json } from '@sveltejs/kit';
import { notificationRequest, notificationCategories, boundedJson } from '$lib/server/notification-settings';
import type { RequestHandler } from './$types';
const headers={'Cache-Control':'no-store, private'};
export const GET:RequestHandler=async event=>json({...await notificationRequest(event,'/settings'),categories:notificationCategories(event.locals.user)},{headers});
export const PUT:RequestHandler=async event=>{
 const value=await boundedJson(event.request);
 const available=notificationCategories(event.locals.user);
 for(const key of ['workflow','trading','financing'])if(value.subscriptions?.[key]?.length&&!available.includes(key))error(403,'无权订阅此类通知');
 return json(await notificationRequest(event,'/settings','PUT',value),{headers});
};
