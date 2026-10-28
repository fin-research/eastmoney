import { z } from 'zod';
import { ApiError, shanghaiToday } from '../http';
import { requestCamelResource, type CamelDependencies, type CamelEnv, type CamelResourceRequest } from './client';
import {
  camelAttachmentSchema, camelBorrowingPageSchema, camelDraftSchema,
  camelImportRecordSchema, type CamelBorrowing, type CamelImportRecord,
} from './contracts';

const parserResponseSchema = z.object({
  status: z.string(), totalNum: z.number().int().nonnegative(),
  warnings: z.unknown().optional(), data: z.array(z.record(z.string(), z.unknown())).max(200),
});
const parsedRecordSchema = camelImportRecordSchema.omit({
  busiDate: true, ourpartyName: true, counterpartyName: true, matchAmount: true,
  matchTime: true, firstSettleDate: true, interestRate: true, totalInterest: true,
  expireAmount: true, counterpartyAccount: true, ourpartyAccount: true, days: true, daysPurpose: true,
});

export function camelService(env: CamelEnv, dependencies: CamelDependencies = {}) {
  const call = <T>(path: string, input: CamelResourceRequest, schema: z.ZodType<T>) =>
    requestCamelResource(env, path, input, schema, dependencies);
  const post = <T>(path: string, json: Record<string, unknown>, schema: z.ZodType<T>) =>
    call(path, { json, withHeader: true }, schema);
  const query = (date: string, current = 1, size = 50) => post('/camel/interbank/borrowing/query', {
    dateType: '0', startDate: date, endDate: date, current, size,
  }, camelBorrowingPageSchema);
  async function all(date: string) {
    const rows: CamelBorrowing[] = [];
    const seen = new Set<string>();
    let expected: number | undefined;
    for (let current = 1; ; current++) {
      const page = await query(date, current);
      if (expected !== undefined && expected !== page.total) throw new ApiError(409, '台账总数发生变化，请重新查询');
      expected = page.total;
      for (const row of page.records) {
        if (seen.has(String(row.id))) throw new ApiError(503, '台账分页重复');
        seen.add(String(row.id)); rows.push(row);
      }
      if (rows.length === expected) return rows;
      if (!page.records.length || rows.length > expected) throw new ApiError(503, '台账分页不完整');
    }
  }
  function multipart(file: File | Request): CamelResourceRequest {
    if (file instanceof Request) return { stream: { body: file.body!, contentType: file.headers.get('Content-Type')! } };
    const form = new FormData(); form.set('file', file, file.name);
    return { form };
  }
  async function parse(file: File | Request) {
    const raw = await call('/camel/interbank/borrowing/excel/parse', multipart(file), parserResponseSchema);
    console.log(JSON.stringify({ event: 'camel_excel_parsed', records: raw.data.length }));
    if (raw.status !== 'SUCCESS' || (Array.isArray(raw.warnings) ? raw.warnings.length > 0 : Boolean(raw.warnings)) ||
      raw.data.some(row => Object.entries(row).some(([key, value]) => /(?:Flg|Flag)$/.test(key) && key !== 'totalInterestRedFlg' && value === true))) {
      throw new ApiError(422, '资金系统解析存在警告');
    }
    // Original Excel values are applied in the browser; parser financial values may be rounded or blank.
    // Validate structural fields while allowing the source overrides to arrive at import time.
    const records = raw.data.map(row => parsedRecordSchema.parse(row));
    if (raw.totalNum !== records.length || new Set(records.map(r => r.serialNo)).size !== records.length) throw new ApiError(422, '解析交易编号或数量不一致');
    return { status: 'SUCCESS' as const, data: records, totalNum: raw.totalNum };
  }
  async function importRecords(records: CamelImportRecord[]) {
    const dates = new Set(records.map(r => r.busiDate));
    if (dates.size !== 1 || new Set(records.map(r => r.serialNo)).size !== records.length) throw new ApiError(422, '成交日期或交易编号不一致');
    const existing = await all(records[0]!.busiDate);
    const ids = new Set(existing.map(row => row.serialNo));
    // No mixed save: the browser reconciles a resumed batch before making another write.
    if (records.some(row => ids.has(row.serialNo))) throw new ApiError(409, '台账已存在，请重新查询导入进度');
    const check = await post('/camel/income/certificate/checkPublishAmount', { amount: 0 }, z.object({ checkResult: z.boolean() }));
    if (!check.checkResult) throw new ApiError(422, '资金系统额度检查未通过');
    await call('/camel/interbank/borrowing/excel/data/save', { json: records }, z.unknown());
    return { saved: true as const };
  }
  const detail = (hid: string) => call(`/camel/fund/transfer/fundAllocate?hid=${encodeURIComponent(hid)}`, { method: 'GET' }, camelDraftSchema);
  async function createDraft(date: string, serialNo: string, attachmentIds: (string | number)[]) {
    const matches = (await all(date)).filter(row => row.serialNo === serialNo);
    if (matches.length !== 1) throw new ApiError(409, '未找到唯一拆借台账');
    const row = matches[0]!;
    if (row.hid) throw new ApiError(409, '还款草稿已存在，请查询草稿');
    if (row.dataSource !== 'Excel上传' || !['UN_EXPIRE', 'EXPIRE'].includes(String(row.paymentStatus))) throw new ApiError(422, '台账不支持创建还款草稿');
    const fields = ['disburseAccountId', 'disburseAccount', 'disburseAccountBank', 'disburseAccountName', 'disburseAccountBranch', 'disburseAccountBranchNo'] as const;
    if (fields.some(key => row[key] === null || row[key] === undefined || row[key] === '') || !(Number(row.expireAmount) > 0)) throw new ApiError(422, '台账还款账户或金额缺失');
    const context = await post('/camel/user/getUserContext?sysNo=CAMEL', {}, z.object({ contextMap: z.object({ depId: z.union([z.string().min(1), z.number().int()]) }) }));
    const payer = await call('/camel/interbank/borrowing/repay/account/info', { method: 'GET' }, z.object({
      id: z.union([z.string().min(1), z.number().int()]), code: z.string().min(1),
      bankName: z.string().min(1), bankBranchName: z.string().min(1), name: z.string().min(1), bankBranchNo: z.string().min(1),
    }));
    const hid = await post('/camel/interbank/borrowing/repaymentAllocate/save', {
      applyDate: shanghaiToday(), deptId: String(context.contextMap.depId), associateType: '3',
      reservationId: row.financingCode || '', fundStructId: '103010000', useTime: row.firstSettleDate,
      bizAbstract: 'REPAY_CAPITAL_AND_INTEREST', currency: 'CNY', purpose: '同业拆入还款',
      amount: String(row.expireAmount), applyRemark: '', emergencyLevel: 0,
      receiveAccountId: row.disburseAccountId, receiveAccountCode: row.disburseAccount,
      skyh: row.disburseAccountBank, skzh: row.disburseAccount, skhm: row.disburseAccountName,
      skkhh: row.disburseAccountBranch, skdehh: row.disburseAccountBranchNo,
      disburseAccountId: payer.id, disburseAccountCode: payer.code, hkyh: payer.bankName,
      hkkhh: payer.bankBranchName, hkzh: payer.code, hkhm: payer.name, hkdehh: payer.bankBranchNo,
      remark: row.serialNo, repaymentId: row.id, hid: null, attachments: attachmentIds,
    }, z.union([z.string().min(1).max(256), z.number().int()]));
    return { hid };
  }
  async function upload(file: File | Request) {
    return call('/camel/file', multipart(file), camelAttachmentSchema);
  }
  return { query, all, parse, importRecords, detail, createDraft, upload };
}
