import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestCamelResource, type CamelSessionCache } from '../src/camel/client';
import { camelService } from '../src/camel/service';
import { handleCamelRequest } from '../src/camel/routes';
import { handleGatewayRequest, handlePublicRequest } from '../src/public-access';
import { allowRateLimits } from './rate-limit-bindings';
import type { CamelImportRecord } from '../src/camel/contracts';

const serialNo = 'IBO20261015000001';
const day = '2026-10-15';
const borrowing = {
  id: 'ledger', serialNo, busiDate: day, firstSettleDate: '2026-10-22', expireAmount: '10000123.45',
  dataSource: 'Excel上传', paymentStatus: 'UN_EXPIRE', financingCode: 'financing',
  disburseAccountId: 'receiver', disburseAccount: '00001234', disburseAccountBank: '收款银行',
  disburseAccountName: '收款人', disburseAccountBranch: '收款支行', disburseAccountBranchNo: '200',
};
const record: CamelImportRecord = {
  serialNo, busiDate: day, ourpartyName: '证券', counterpartyName: '银行',
  matchAmount: '1000', matchTime: day, firstSettleDate: '2026-10-22',
  interestRate: '0.01296', totalInterest: '123.45', expireAmount: '10000123.45',
  counterpartyAccount: '00001234', ourpartyAccount: '000001', days: 3, daysPurpose: 1,
};
function setup(handler: (request: Request) => Promise<Response>) {
  const upstream = vi.fn(async (input: RequestInfo | URL) => handler(input instanceof Request ? input : new Request(input)));
  const env = { CAMEL: { fetch: upstream }, CAMEL_LIMIT: allowRateLimits().CAMEL_LIMIT } as unknown as Cloudflare.Env;
  const cache: CamelSessionCache = {
    match: async () => Response.json({ accessToken: 'cached', tokenName: 'name', deviceId: 'f6e48a8d-da7f-4735-b897-8d188b374677', expiresAt: Date.now() + 3600000 }),
    put: async () => {}, delete: async () => true,
  };
  return { env, dependencies: { cache }, upstream };
}
const ok = (data: unknown) => Response.json({ success: true, data });

describe('internal CAMEL business adapter', () => {
  it('uses GET, raw arrays and multipart without an args envelope; does not leak upstream fields', async () => {
    const requests: Request[] = [];
    const { env, dependencies } = setup(async request => {
      requests.push(request);
      if (new URL(request.url).pathname === '/camel/file') {
        const form = await request.formData();
        expect((form.get('file') as File).name).toBe('附件.pdf');
        return ok({ id: 'attachment', privateSecret: 'hidden' });
      }
      if (request.method === 'GET') return ok({ value: 1 });
      expect(await request.json()).toEqual([record]);
      return ok(null);
    });
    await requestCamelResource(env, '/test', { json: [record] }, z.unknown(), dependencies);
    await requestCamelResource(env, '/test', { method: 'GET' }, z.object({ value: z.number() }), dependencies);
    expect(await camelService(env, dependencies).upload(new File(['%PDF'], '附件.pdf'))).toEqual({ id: 'attachment' });
    expect(requests.every(r => r.headers.get('Cookie') === 'dchktoken=cached')).toBe(true);
    expect(requests.every(r => r.redirect === 'manual')).toBe(true);
  });

  it('does not retry unknown write outcomes or business messages mentioning expiry', async () => {
    for (const response of [() => { throw new Error('lost response'); }, () => Response.json({ code: 400, message: '业务已过期' }), () => new Response('invalid')]) {
      const { env, dependencies, upstream } = setup(async () => response());
      await expect(requestCamelResource(env, '/camel/file', { json: {} }, z.unknown(), dependencies)).rejects.toThrow();
      expect(upstream).toHaveBeenCalledOnce();
    }
  });

  it('checks all parser warning flags before projecting the fixed DTO', async () => {
    const { env, dependencies } = setup(async () => ok({ status: 'SUCCESS', totalNum: 1, data: [{ ...record, unknownRiskFlag: true }] }));
    await expect(camelService(env, dependencies).parse(new File(['excel'], 'trades.xlsx'))).rejects.toMatchObject({ status: 422 });
    const valid = setup(async () => ok({ status: 'SUCCESS', totalNum: 1, data: [{ ...record, totalInterestRedFlg: true, contractNo: 'contract', counterpartyBankBranchName: 'settlement branch', ourTrader: 'trader', setdays: 3, daysRedFlg: false, internalKey: 'hidden' }] }));
    const parsed = await camelService(valid.env, valid.dependencies).parse(new File(['excel'], 'trades.xlsx'));
    expect(parsed.data[0]).toMatchObject({ serialNo, contractNo: 'contract', counterpartyBankBranchName: 'settlement branch', ourTrader: 'trader', setdays: 3, daysRedFlg: false });
    expect(parsed.data[0]).not.toHaveProperty('internalKey');
  });

  it('checks duplicates on later pages before any import or amount check', async () => {
    const { env, dependencies, upstream } = setup(async request => {
      const body = await request.json() as { current: number };
      return ok({ total: 2, records: [{ ...borrowing, id: String(body.current), serialNo: body.current === 1 ? 'other' : serialNo }] });
    });
    await expect(camelService(env, dependencies).importRecords([record])).rejects.toMatchObject({ status: 409 });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('saves a raw record array only after a clean query and successful amount check', async () => {
    const paths: string[] = [];
    const { env, dependencies } = setup(async request => {
      const path = new URL(request.url).pathname; paths.push(path);
      if (path.endsWith('/query')) return ok({ total: 0, records: [] });
      if (path.endsWith('checkPublishAmount')) return ok({ checkResult: true });
      expect(await request.json()).toEqual([record]); return ok(null);
    });
    expect(await camelService(env, dependencies).importRecords([record])).toEqual({ saved: true });
    expect(paths).toEqual(['/camel/interbank/borrowing/query', '/camel/income/certificate/checkPublishAmount', '/camel/interbank/borrowing/excel/data/save']);
  });

  it('builds a draft from system ledger/context/accounts and never accepts a submit action', async () => {
    const paths: string[] = [];
    const { env, dependencies } = setup(async request => {
      const path = new URL(request.url).pathname; paths.push(path);
      if (path.endsWith('/query')) return ok({ total: 1, records: [borrowing] });
      if (path.endsWith('/getUserContext')) return ok({ contextMap: { depId: 'dept' } });
      if (path.endsWith('/account/info')) return ok({ id: 'payer', code: '00005678', bankName: '付款银行', bankBranchName: '付款支行', name: '付款人', bankBranchNo: '100' });
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ amount: '10000123.45', receiveAccountCode: '00001234', disburseAccountCode: '00005678', repaymentId: 'ledger', associateType: '3', hid: null, attachments: ['attachment'] });
      expect(body).not.toHaveProperty('args'); expect(body).not.toHaveProperty('submit'); return ok('draft');
    });
    expect(await camelService(env, dependencies).createDraft(day, serialNo, ['attachment'])).toEqual({ hid: 'draft' });
    expect(paths).toHaveLength(4);
    const response = await handleCamelRequest(new Request('https://data/camel/repayment-drafts', { method: 'POST', body: JSON.stringify({ date: day, serialNo, attachmentIds: ['file'], submit: true }) }), env, dependencies);
    expect(response?.status).toBe(422); expect(paths).toHaveLength(4);
  });

  it('rejects existing drafts before requesting accounts or saving again', async () => {
    const { env, dependencies, upstream } = setup(async () => ok({ total: 1, records: [{ ...borrowing, hid: 'existing' }] }));
    await expect(camelService(env, dependencies).createDraft(day, serialNo, ['attachment'])).rejects.toMatchObject({ status: 409 });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('requires the dedicated Gateway verdict and keeps the default entrypoint closed and checks file/body/method before upstream calls', async () => {
    const { env, dependencies, upstream } = setup(async () => ok({}));
    const context = Buffer.from(JSON.stringify({ version: 1, choice: { status: 204 } })).toString('base64url');
    for (const path of ['/data/camel/borrowings', '/camel/repayment-drafts']) {
      const request = new Request('https://data' + path, { headers: { 'X-Eastmoney-Gateway-Context': context } });
      expect((await handleGatewayRequest(request, env)).status).toBe(403);
      expect((await handlePublicRequest(request, env)).status).toBe(404);
    }
    expect((await handleCamelRequest(new Request('https://data/camel/attachments', { method: 'POST', body: 'bad' }), env, dependencies))?.status).toBe(422);
    expect((await handleCamelRequest(new Request('https://data/camel/repayment-drafts/1', { method: 'DELETE' }), env, dependencies))?.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

it('streams multipart bodies through VPC without buffering or retrying a consumed write', async () => {
  let received = 0;
  const { env, dependencies, upstream } = setup(async request => {
    expect(request.headers.get('Content-Type')).toContain('multipart/form-data');
    const reader = request.body!.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; }
    return Response.json({ code: 4107, success: false });
  });
  const result = await handleCamelRequest(new Request('https://data/camel/attachments', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('附件.pdf') }, body: new Uint8Array(100_000) }), env, dependencies);
  expect(result?.status).toBe(503);
  expect(received).toBeGreaterThan(100_000);
  expect(upstream).toHaveBeenCalledOnce();
  const invalidated = vi.spyOn(dependencies.cache, 'delete');
  await handleCamelRequest(new Request('https://data/camel/attachments', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'trade.pdf' }, body: 'pdf' }), env, dependencies);
  expect(invalidated).toHaveBeenCalledOnce();
  const calls = upstream.mock.calls.length;
  const tooLarge = await handleCamelRequest(new Request('https://data/camel/attachments', { method: 'POST', headers: { 'Content-Length': String(20 * 1024 * 1024), 'Content-Type': 'application/pdf', 'X-Filename': 'trade.pdf' }, body: 'test' }), env, dependencies);
  expect(tooLarge?.status).toBe(413);
  for (const filename of ['other.exe', '../trade.pdf', 'one.pdf%0D%0Ainject']) {
    const rejected = await handleCamelRequest(new Request('https://data/camel/attachments', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': filename }, body: 'pdf' }), env, dependencies);
    expect(rejected?.status).toBe(422);
  }
  expect(upstream).toHaveBeenCalledTimes(calls);
});

it('Gateway CAMEL verdict enables only the fixed adapter; query validation runs before upstream', async()=>{
 const {env,upstream}=setup(async()=>ok({}));
 const context=Buffer.from(JSON.stringify({version:1,choice:{status:401},camel:{status:204}})).toString('base64url');
 const request=(path:string,method='GET')=>new Request('https://data/data/camel/'+path,{method,headers:{'X-Eastmoney-Gateway-Context':context}});
 expect((await handleGatewayRequest(request('borrowings?date=invalid'),env)).status).toBe(422);
 const head=await handleGatewayRequest(request('borrowings?date=invalid','HEAD'),env);
 expect(head.status).toBe(422);expect(await head.text()).toBe('');
 expect((await handleGatewayRequest(request('borrowings?date=2026-10-15&date=2026-10-16'),env)).status).toBe(400);
 expect((await handleGatewayRequest(request('borrowings?date=2026-10-15&extra=1'),env)).status).toBe(400);
 expect((await handleGatewayRequest(request('repayment-drafts/1?extra=1'),env)).status).toBe(400);
 expect((await handleGatewayRequest(request('accounts'),env)).status).toBe(404);
 expect((await handleGatewayRequest(request('borrowings','DELETE'),env)).status).toBe(404);
 expect(upstream).not.toHaveBeenCalled();
});
