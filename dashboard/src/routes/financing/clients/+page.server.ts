import { error, fail } from '@sveltejs/kit';
import { getDatabase } from '$lib/server/financing/db.js';
import { listClients, saveClient } from '$lib/server/financing/clients';
import { hasPermission } from '$lib/permissions';
import type { Actions, PageServerLoad } from './$types';
export const load:PageServerLoad=async(event)=>{
  if(!event.locals.user?.authorization||!hasPermission(event.locals.permissions,'financing.data:read'))throw error(403,'无权查看客户');
  const query=(event.url.searchParams.get('q')??'').slice(0,200);
  const page=Math.max(1,Math.min(100000,Number(event.url.searchParams.get('page'))||1));
  return {...await listClients(getDatabase(event),query,Math.floor(page)),query,page:Math.floor(page),permissions:event.locals.permissions};
};
const save:Actions[string]=async(event)=>{
  if(event.request.headers.get('origin')!==event.url.origin)throw error(403,'仅允许从本站提交操作');
  const action=event.url.searchParams.has('/create')?'create':'update';
  if(!event.locals.user?.authorization||!hasPermission(event.locals.permissions,`financing.data:${action}`))throw error(403,'无权维护客户');
  const form=await event.request.formData();
  try {
    const id=action==='create'?null:String(form.get('id')??'');
    if(id!==null&&!/^\d+$/.test(id))return fail(400,{error:'客户编号无效'});
    const record=await saveClient(getDatabase(event),id,{name:form.get('name'),fullname:form.get('fullname')||null,type:form.get('type'),subtype:form.get('subtype')||null,
      aliases:String(form.get('aliases')??'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean),version:form.get('version')??undefined});
    return {record};
  }catch(failure){
    const code=(failure as {code?:string}).code;
    return fail(400,{error:code?'客户名称或别名重复，或记录违反关联约束':failure instanceof Error&&failure.name!=='ZodError'?failure.message:'客户字段无效'});
  }
};
export const actions:Actions={create:save,update:save};
