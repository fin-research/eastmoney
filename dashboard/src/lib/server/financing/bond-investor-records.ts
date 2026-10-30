type Db={query(sql:string,values?:unknown[]):Promise<{rows:any[]}>};
export async function createBondInvestor(db:Db,x:{bondName:string;investorName:string;channel:string|null;account:string|null;amount:number}){
 const bonds=(await db.query('SELECT id,amount FROM financing.bond WHERE name=$1 FOR UPDATE',[x.bondName])).rows;if(bonds.length!==1)throw Error('债券简称不存在或不唯一');
 const client=(await db.query('SELECT public.resolve_client($1)::text AS id',[x.investorName])).rows[0]?.id;if(!client)throw Error('实际投资人尚未登记，请先维护客户');
 if((await db.query('SELECT COALESCE(sum(amount),0)+$2::numeric > $3::numeric AS exceeds FROM financing.bond_investors WHERE bond_id=$1',[bonds[0].id,x.amount,bonds[0].amount])).rows[0].exceeds)throw Error('投资分配合计超过债券本金');
 return (await db.query('INSERT INTO financing.bond_investors(bond_id,investor_id,channel,account,amount) VALUES($1,$2,$3,$4,$5::numeric) RETURNING id::text,bond_id::text,investor_id::text,channel,account,amount::text AS amount',[bonds[0].id,client,x.channel,x.account,x.amount])).rows[0];
}
export async function updateBondInvestor(db:Db,x:{id:string;oldBondName:string;oldInvestorName:string|null;oldChannel:string|null;oldAccount:string|null;oldAmount:number;investorName:string;channel:string|null;account:string|null;amount:number}){
 const bonds=(await db.query('SELECT id,amount FROM financing.bond WHERE name=$1 FOR UPDATE',[x.oldBondName])).rows;if(bonds.length!==1)throw Error('债券简称不存在或不唯一');
 const current=(await db.query('SELECT i.id::text,i.bond_id,c.name AS investor_name,i.channel,i.account,i.amount::text FROM financing.bond_investors i LEFT JOIN public.client c ON c.id=i.investor_id WHERE i.id=$1 AND i.bond_id=$2 FOR UPDATE OF i',[x.id,bonds[0].id])).rows[0];
 if(!current||current.investor_name!==x.oldInvestorName||current.channel!==x.oldChannel||current.account!==x.oldAccount||!(await db.query('SELECT $1::numeric=$2::numeric AS matches',[current.amount,x.oldAmount])).rows[0].matches)throw Error('投资分配已变化，请重新读取后修改');
 const client=(await db.query('SELECT public.resolve_client($1)::text AS id',[x.investorName])).rows[0]?.id;if(!client)throw Error('实际投资人尚未登记，请先维护客户');
 if((await db.query('SELECT COALESCE(sum(amount),0)+$3::numeric > $4::numeric AS exceeds FROM financing.bond_investors WHERE bond_id=$1 AND id<>$2',[bonds[0].id,x.id,x.amount,bonds[0].amount])).rows[0].exceeds)throw Error('投资分配合计超过债券本金');
 return (await db.query('UPDATE financing.bond_investors SET investor_id=$2,channel=$3,account=$4,amount=$5::numeric WHERE id=$1 RETURNING id::text,bond_id::text,investor_id::text,channel,account,amount::text AS amount',[x.id,client,x.channel,x.account,x.amount])).rows[0];
}
