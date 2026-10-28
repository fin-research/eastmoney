import { error, fail } from '@sveltejs/kit';
import { isNotificationAdmin, parseTestMessage } from '$lib/server/admin-test-messages';
import { createDirectory } from '$lib/server/auth0-directory';
import type { TestSendResult } from '$lib/messenger/types';
import { messengerJson, messengerRequest, type DeliveryList, type DeliveryDetail } from '$lib/server/messenger';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, locals, url }) => {
  if (!isNotificationAdmin(locals.user)) error(403,'仅管理员可访问通知管理');
  const query=new URLSearchParams();
  for(const key of ['status','channel','source','before']) { const value=url.searchParams.get(key); if(value)query.set(key,value); }
  const binding=platform!.env.MESSENGER_ADMIN;
  try {
    const list=await messengerJson<DeliveryList>(binding,`/messages?${query}`);
    const id=url.searchParams.get('id');
    const detail=id && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? await messengerJson<DeliveryDetail>(binding,`/messages/${id}`) : null;
    const people = (await createDirectory(platform!.env).people()).filter(person => person.active).map(({id,name,email}) => ({id,name,email}));
    return { list, detail, people, requestId:crypto.randomUUID(), filters: Object.fromEntries(query), canRetry:true, canSend:true };
  } catch { error(503,'消息中台暂时不可用'); }
};
export const actions: Actions = {
  sendTest: async ({request,platform,locals}) => {
    if (!isNotificationAdmin(locals.user)) return fail(403,{message:'仅管理员可发送测试消息'});
    let value;
    try {
      const people = await createDirectory(platform!.env).people();
      value = parseTestMessage(await request.formData(),people);
    } catch (cause) { return fail(400,{message:cause instanceof Error ? cause.message : '发送参数无效'}); }
    try {
      const response = await messengerRequest(platform!.env.MESSENGER_ADMIN,'/test-messages',{
        ...value,actor:locals.user!.auth0Id ?? locals.user!.id,
      });
      if (!response.ok) return fail(response.status === 409 ? 409 : 503,{message:response.status === 409 ? '该次发送已提交不同内容，请刷新后重试' : '测试消息提交失败，请重试'});
      return {testResult:await response.json() as TestSendResult};
    } catch { return fail(503,{message:'消息中台暂时不可用，请保留当前页面重试'}); }
  },
  retry: async ({request,platform,locals}) => {
    if(!isNotificationAdmin(locals.user)) return fail(403,{message:'仅管理员可重试消息'});
    const form=await request.formData(),id=String(form.get('id') ?? '');
    if(!/^[a-zA-Z0-9-]{1,80}$/.test(id))return fail(400,{message:'消息编号无效'});
    try {
      const response=await messengerRequest(platform!.env.MESSENGER_ADMIN,`/messages/${id}/retry`,{
        actor:locals.user!.auth0Id ?? locals.user!.id,confirmUncertain:form.get('confirmUncertain')==='yes',
      });
      if(!response.ok)return fail(response.status===409?409:503,{message:response.status===409?'消息状态已变化，请刷新后重试':'重试提交失败'});
      return {message:'已加入重试队列'};
    }catch{return fail(503,{message:'消息中台暂时不可用'});}
  },
};
