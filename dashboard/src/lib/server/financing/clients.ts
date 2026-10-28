import { clientInputSchema } from '../../financing/client-input.ts';

const projection=`c.id::text,c.name,c.fullname,c.type,c.subtype,
  COALESCE((SELECT json_agg(a.alias ORDER BY a.alias) FROM public.client_alias a WHERE a.client_id=c.id),'[]') AS aliases,
  md5(row_to_json(c)::text || COALESCE((SELECT string_agg(a.alias,',' ORDER BY a.alias) FROM public.client_alias a WHERE a.client_id=c.id),'')) AS version`;
export async function listClients(db:any,query='',page=1) {
  const params=[`%${query}%`];
  const where=`WHERE c.name ILIKE $1 OR c.fullname ILIKE $1 OR c.type ILIKE $1 OR EXISTS(SELECT 1 FROM public.client_alias a WHERE a.client_id=c.id AND a.alias ILIKE $1)`;
  const total=Number((await db.query(`SELECT count(*) FROM public.client c ${where}`,params)).rows[0].count);
  const rows=(await db.query(`SELECT ${projection} FROM public.client c ${where} ORDER BY c.name,c.id LIMIT 50 OFFSET $2`,[...params,(page-1)*50])).rows;
  return {rows,total};
}
export async function saveClient(db:any,id:string|null,raw:unknown) {
  const input=clientInputSchema.parse(raw);
  return db.transaction(async(tx:any)=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'))");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('credit.excel_import',0))");
    const existing=id?(await tx.query(`SELECT ${projection} FROM public.client c WHERE c.id=$1`,[id])).rows[0]:null;
    if(id&&(!existing||existing.version!==input.version))throw new Error('客户已被修改，请刷新列表后重试');
    // Preserve all established source-name resolutions, including explicit exceptions.
    const names=await tx.query(`SELECT value,public.resolve_client(value)::text AS client_id FROM (
      SELECT counterparty AS value FROM financing.debt WHERE counterparty IS NOT NULL
      UNION SELECT name FROM public.client UNION SELECT fullname FROM public.client WHERE fullname IS NOT NULL
      UNION SELECT alias FROM public.client_alias
      UNION SELECT institution_name FROM credit.institution_client
    ) names`);
    const record=id
      ?(await tx.query('UPDATE public.client SET name=$2,fullname=$3,type=$4,subtype=$5 WHERE id=$1 RETURNING id::text',[id,input.name,input.fullname||null,input.type,input.subtype||null])).rows[0]
      :(await tx.query('INSERT INTO public.client(name,fullname,type,subtype) VALUES($1,$2,$3,$4) RETURNING id::text',[input.name,input.fullname||null,input.type,input.subtype||null])).rows[0];
    const aliases=[...input.aliases];
    if(existing?.name&&existing.name!==input.name)aliases.push(existing.name);
    if(existing?.fullname&&existing.fullname!==input.fullname)aliases.push(existing.fullname);
    const normalized=(await tx.query('SELECT DISTINCT public.client_match_key(value) AS alias FROM unnest($1::text[]) value',[aliases])).rows.map((row:any)=>row.alias);
    for(const alias of normalized){
      if(!alias)throw new Error('别名不能为空');
      const resolved=(await tx.query('SELECT public.resolve_client($1)::text AS id',[alias])).rows[0].id;
      if(resolved&&resolved!==record.id)throw new Error(`别名已关联其他客户：${alias}`);
    }
    await tx.query('DELETE FROM public.client_alias WHERE client_id=$1',[record.id]);
    for(const alias of normalized)await tx.query('INSERT INTO public.client_alias(alias,client_id) VALUES($1,$2)',[alias,record.id]);
    const changed=(await tx.query(`SELECT source.value FROM jsonb_to_recordset($1::jsonb) source(value text,client_id text)
      WHERE source.client_id IS NOT NULL AND public.resolve_client(source.value)::text IS DISTINCT FROM source.client_id LIMIT 1`,[JSON.stringify(names.rows)])).rows[0];
    if(changed)throw new Error(`修改会改变已有客户归属：${changed.value}`);
    await tx.query(`WITH names AS MATERIALIZED (SELECT counterparty,public.resolve_client(counterparty) AS client_id FROM
      (SELECT DISTINCT counterparty FROM financing.debt WHERE client_id IS NULL) n)
      UPDATE financing.debt d SET client_id=n.client_id FROM names n WHERE d.client_id IS NULL AND d.counterparty=n.counterparty AND n.client_id IS NOT NULL`);
    return (await tx.query(`SELECT ${projection} FROM public.client c WHERE c.id=$1`,[record.id])).rows[0];
  });
}
