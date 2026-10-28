import { correctedRecords, type PreparedBatch, type Journal, type LedgerRow } from './model.ts';
export type Api = (path:string, init?:RequestInit) => Promise<any>;
export type Persist = (journal:Journal) => void | Promise<void>;
export async function ledgerRows(api:Api,date:string):Promise<LedgerRow[]> {
  const rows:LedgerRow[] = [];
  let total:number|undefined;
  const ids=new Set<string>(),serials=new Set<string>();
  for (let current=1;current<=100;current++) {
    const result = await api(`/borrowings?date=${date}&current=${current}&size=50`);
    if (!Array.isArray(result.records) || !Number.isInteger(result.total)) throw new Error('台账响应无效');
    if (total!==undefined && total!==result.total) throw new Error('台账分页总数已改变');
    total=result.total;
    for (const row of result.records) {
      if (!identifier(row.id) || !row.serialNo || ids.has(String(row.id)) || serials.has(row.serialNo)) throw new Error('台账 ID 或成交编号无效或重复');
      ids.add(String(row.id));serials.add(row.serialNo);
    }
    rows.push(...result.records);
    if (rows.length > result.total) throw new Error('台账分页总数不一致');
    if (rows.length === result.total) return rows;
    if (!result.records.length) throw new Error('台账分页不完整');
  }
  throw new Error('台账超过查询限制');
}
function identifier(value:unknown): value is string | number { return (typeof value==='string' && !!value) || (typeof value==='number' && Number.isFinite(value) && value!==0); }
export async function verifyDraft(api:Api,row:LedgerRow,hid:string|number,attachments:(string|number)[]) {
  const value = await api(`/repayment-drafts/${encodeURIComponent(hid)}`);
  const ids = value.attachmentList?.map((item:{id:unknown})=>String(item.id)).sort();
  if (String(value.hid)!==String(hid) || value.reservationId!==row.financingCode || value.remark!==row.serialNo || String(value.reviewStatus)!=='0' || String(value.status)!=='0' || value.repaymentId!=null && String(value.repaymentId)!==String(row.id) || JSON.stringify(ids)!==JSON.stringify(attachments.map(String).sort())) throw new Error(`草稿关联或状态不符：${row.serialNo}`);
}
/** Every mutation is preceded by a durable intent. Unknown results are reconciled, never blindly replayed. */
export async function runWorkflow(batch:PreparedBatch,journal:Journal,api:Api,persist:Persist) {
  if (!journal.archived || journal.signature!==batch.signature) throw new Error('请先保存本批文件');
  if (Object.values(journal.uploads).some(upload=>!identifier(upload.id))) throw new Error('附件上传结果未知，已停止；请人工确认资金系统附件');
  let rows = await ledgerRows(api,batch.date);
  const index = () => new Map(rows.map(row=>[row.serialNo,row]));
  let existing = index();
  const pending = batch.trades.filter(trade=> {
    const progress = journal.trades[trade.serialNo] ??= {};
    const row = existing.get(trade.serialNo);
    if (row) {
      if (progress.id!=null && String(progress.id)!==String(row.id)) throw new Error(`台账 ID 已改变：${trade.serialNo}`);
      progress.import='verified';progress.id=row.id;return false;
    }
    if (progress.import) throw new Error(`导入结果无法确认：${trade.serialNo}`);
    return true;
  });
  await persist(journal);
  if (pending.length) {
    const excel = batch.files.find(file=>file.name===batch.excel)!;
    const records = correctedRecords(await api('/borrowings/parse',{method:'POST',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','X-Filename':encodeURIComponent(excel.name)},body:new Blob([new Uint8Array(excel.bytes).buffer])}),batch.trades).filter(record=>pending.some(trade=>trade.serialNo===record.serialNo));
    pending.forEach(trade=>journal.trades[trade.serialNo]!.import='intent');await persist(journal);
    await api('/borrowings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records})});
    rows = await ledgerRows(api,batch.date);existing=index();
    for (const trade of pending) {
      const row=existing.get(trade.serialNo);
      if (!row) throw new Error(`导入后未查到台账：${trade.serialNo}`);
      journal.trades[trade.serialNo]={...journal.trades[trade.serialNo],import:'verified',id:row.id};
    }
    await persist(journal);
  }
  for (const trade of batch.trades) {
    const serial=trade.serialNo,row=existing.get(serial)!,progress=journal.trades[serial]!;
    const files=batch.files.filter(file=>file.serialNo===serial);
    if (progress.draft==='verified') {
      if (String(progress.hid)!==String(row.hid)) throw new Error(`草稿 ID 已改变：${serial}`);
      continue;
    }
    if (row.hid) {
      if (!progress.attachments?.length || files.some(file=>!journal.uploads[file.name]?.id || journal.uploads[file.name]!.digest!==file.digest || !progress.attachments!.map(String).includes(String(journal.uploads[file.name]!.id)))) throw new Error(`已有草稿附件无法确认：${serial}`);
      if (progress.hid!=null && String(progress.hid)!==String(row.hid)) throw new Error(`草稿 ID 已改变：${serial}`);
      await verifyDraft(api,row,row.hid,progress.attachments);
      progress.hid=row.hid;progress.draft='verified';await persist(journal);continue;
    }
    if (progress.draft) throw new Error(`草稿保存结果无法确认：${serial}`);
    const ids:(string|number)[]=[];
    for (const file of files) {
      let upload=journal.uploads[file.name];
      if (upload && (upload.digest!==file.digest || !identifier(upload.id))) throw new Error(`附件上传结果无法确认：${file.name}`);
      if (!upload) {
        upload=journal.uploads[file.name]={digest:file.digest,status:'intent'};await persist(journal);
        const result=await api('/attachments',{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(file.name)},body:new Blob([new Uint8Array(file.bytes).buffer])});
        if (!identifier(result.id)) throw new Error('附件 ID 无效');
        upload.id=result.id;upload.status='uploaded';await persist(journal);
      }
      ids.push(upload.id!);
    }
    progress.draft='intent';progress.attachments=ids;await persist(journal);
    const result=await api('/repayment-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:batch.date,serialNo:serial,attachmentIds:ids})});
    if (!identifier(result.hid)) throw new Error('草稿 ID 无效');
    progress.hid=result.hid;await persist(journal);
    await verifyDraft(api,row,result.hid,ids);
    progress.draft='verified';await persist(journal);
  }
}
