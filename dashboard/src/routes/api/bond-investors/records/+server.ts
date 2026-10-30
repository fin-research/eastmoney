import { z } from 'zod';
import { error } from '@sveltejs/kit';
import { hasPermission } from '$lib/permissions';
import { withPostgres } from '$lib/server/postgres';
import type { RequestHandler } from './$types';
import { createBondInvestorSchema as createSchema, updateBondInvestorSchema as updateSchema } from '$lib/server/bond-investor-record-schema';
import { createBondInvestor, updateBondInvestor } from '$lib/server/financing/bond-investor-records';
const headers={'Cache-Control':'no-store, private'};
export const POST:RequestHandler=async event=>{
 if(!event.locals.user?.authorization||!hasPermission(event.locals.permissions,'financing.data:create'))throw error(403,'无权新增债券投资分配');
 try {const x=createSchema.parse(await event.request.json());const row=await withPostgres(event.platform?.env.HYPERDRIVE?.connectionString,'bond-investor-create',async db=>{await db.query('BEGIN');try{
  const saved=await createBondInvestor(db,x);await db.query('COMMIT');return saved;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}});return Response.json(row,{headers});}catch(e){if(e instanceof z.ZodError)return Response.json({error:'输入字段无效'},{status:400,headers});const code=(e as {code?:string}).code;const message=e instanceof Error?e.message:'';return Response.json({error:code==='23505'?'相同债券、投资人、通道和产品的分配已存在':/债券简称|实际投资人|投资分配合计/.test(message)?message:'债券投资分配新增失败'},{status:code==='23505'?409:409,headers});}
};
export const GET:RequestHandler=async event=>{
 if(!event.locals.user?.authorization||!hasPermission(event.locals.permissions,'financing.data:read'))throw error(403,'无权读取债券投资分配');
 const bondNames=event.url.searchParams.getAll('bondName');if(!bondNames.length||bondNames.length>30||bondNames.some(n=>!n.trim()||n.length>160))return Response.json({error:'债券简称参数无效'},{status:400,headers});
 try {const data=await withPostgres(event.platform?.env.HYPERDRIVE?.connectionString,'bond-investor-reference',async db=>({
  bonds:(await db.query('SELECT id::text,name,subtype,amount::text,issue_date::text,maturity_date::text FROM financing.bond WHERE name=ANY($1::text[]) ORDER BY name',[bondNames])).rows,
  allocations:(await db.query('SELECT i.id::text,b.name AS "bondName",c.name AS "investorName",i.channel,i.account,i.amount::text AS amount FROM financing.bond_investors i JOIN financing.bond b ON b.id=i.bond_id LEFT JOIN public.client c ON c.id=i.investor_id WHERE b.name=ANY($1::text[]) ORDER BY b.name,c.name,i.account',[bondNames])).rows,
  clients:(await db.query('SELECT id::text,name,fullname,type,subtype FROM public.client ORDER BY name')).rows
 }));return Response.json(data,{headers});}catch{return Response.json({error:'债券投资分配查询失败'},{status:503,headers});}
};
export const PATCH:RequestHandler=async event=>{
 if(!event.locals.user?.authorization||!hasPermission(event.locals.permissions,'financing.data:update'))throw error(403,'无权修改债券投资分配');
 try {const x=updateSchema.parse(await event.request.json());const row=await withPostgres(event.platform?.env.HYPERDRIVE?.connectionString,'bond-investor-update',async tx=>{await tx.query('BEGIN');try{
  const saved=await updateBondInvestor(tx,x);await tx.query('COMMIT');return saved;
 }catch(e){await tx.query('ROLLBACK').catch(()=>{});throw e;}});return Response.json(row,{headers});}catch(e){if(e instanceof z.ZodError)return Response.json({error:'输入字段无效'},{status:400,headers});const code=(e as {code?:string}).code;const message=e instanceof Error?e.message:'';return Response.json({error:code==='23505'?'相同债券、投资人、通道和产品的分配已存在':/已变化|债券简称|实际投资人|投资分配合计/.test(message)?message:'债券投资分配修改失败'},{status:409,headers});}
};
