// 资金系统（CAMEL）HTTP 客户端：API 登录（Apple Vision 识别验证码，失败时落盘等 AI 读图）+ 台账/附件/还款划拨。
// 业务调用移植自 data/src/camel/{client,service}.ts。
import { execFileSync } from 'node:child_process';
import { constants, publicEncrypt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'http://10.6.88.192:7000';
const PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDQUDdkHri8QotAJ/GqIZaxE1Vpv1b04LX3NCX64z3DSrAmL8iSHhimNnwOk0iPgI2TV50IKWjy0wLq+ziyMi27xAFvk8T0U1ma9aAn+qmmeKLNK9r0B9sv7Jvv0bbpA9z8sGChFLdf1V624T6s5xlJR2LD1hVIlG1S1s1cNYN6awIDAQAB';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const shanghaiToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function loadEnv() {
  const found = {};
  const dirs = [];
  for (const start of [process.cwd(), here]) {
    for (let d = start; ; d = path.dirname(d)) { dirs.push(d); if (d === path.dirname(d)) break; }
    // worktree 里 .env 在主 checkout 根目录：取 git common dir 的上一级。
    try { dirs.push(path.dirname(path.resolve(start, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()))); } catch {}
  }
  const files = process.env.CAMEL_ENV_FILE ? [process.env.CAMEL_ENV_FILE] : dirs.map(d => path.join(d, '.env'));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(CAMEL_(?:USERNAME|PASSWORD))\s*=\s*(.*?)\s*$/);
      if (m) found[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    if (found.CAMEL_USERNAME && found.CAMEL_PASSWORD) break;
  }
  const username = process.env.CAMEL_USERNAME ?? found.CAMEL_USERNAME, password = process.env.CAMEL_PASSWORD ?? found.CAMEL_PASSWORD;
  if (!username || !password) throw new Error('缺少 CAMEL_USERNAME / CAMEL_PASSWORD（环境变量，或项目根未跟踪的 .env；可用 CAMEL_ENV_FILE 指定）');
  return { username, password };
}

const header = (deviceId, tokenName = '') => ({ deviceId, sysNo: 'CAMEL', traceId: randomUUID().replaceAll('-', ''), transactionId: '', userMark: '', ...(tokenName ? { tokenName } : {}) });
const ok = envelope => envelope.success !== false && (Number(envelope.code) === 200 || (envelope.code === undefined && envelope.success === true));

async function rawPost(url, body, cookie) {
  const response = await fetch(`${ORIGIN}${url}`, { method: 'POST', headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', ...(cookie ? { Cookie: `dchktoken=${cookie}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`资金系统 HTTP ${response.status}：${url}`);
  return response.json();
}

// ───────── 验证码：Apple Vision 优先，AI 读图兜底 ─────────
function ocrBinary() {
  const src = path.join(here, 'captcha-ocr.swift');
  const bin = path.join(os.tmpdir(), `captcha-ocr-${fs.statSync(src).mtimeMs | 0}`);
  if (!fs.existsSync(bin)) execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  return bin;
}
/** 多变体投票：所有变体一致且恰为 4 位字母数字才采纳，否则 null（换一张）。 */
export function ocrCaptcha(file, length = 4) {
  if (process.platform !== 'darwin') return null;
  try {
    const [, ...votes] = execFileSync(ocrBinary(), [file], { encoding: 'utf8' }).trim().split('\n')[0].split('\t');
    return votes[0] && votes.every(v => v === votes[0]) && new RegExp(`^[A-Za-z0-9]{${length}}$`).test(votes[0]) ? votes[0] : null;
  } catch { return null; }
}

/**
 * 登录，返回会话 {token, tokenName, deviceId}。
 * Apple OCR 最多换图 ocrRefreshes 次找到有把握的验证码；仍不行则把图写到 runDir/captcha.png，
 * 等待 AI 读图后写入 runDir/captcha.txt（stderr 输出 NEED_CAPTCHA）。最多提交 3 次。
 */
export async function login({ runDir, ocrRefreshes = 60, submits = 3, aiWaitSeconds = 180, log = console.error } = {}) {
  const { username, password } = loadEnv();
  fs.mkdirSync(runDir, { recursive: true });
  const captchaFile = path.join(runDir, 'captcha.png'), answerFile = path.join(runDir, 'captcha.txt');
  const encrypted = publicEncrypt({ key: Buffer.from(PUBLIC_KEY, 'base64'), format: 'der', type: 'spki', padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString('base64');
  let submitted = 0, refreshes = 0;
  while (submitted < submits) {
    const deviceId = randomUUID();
    const fetchCaptcha = async () => {
      const envelope = await rawPost('/security/getAuthCode', { header: header(deviceId) });
      if (!ok(envelope)) throw new Error('获取验证码失败');
      fs.writeFileSync(captchaFile, Buffer.from(envelope.data.pictureCheckCode.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      return envelope.data.pictureCheckKey;
    };
    let key = await fetchCaptcha(), code = refreshes >= ocrRefreshes ? null : ocrCaptcha(captchaFile), source = 'apple-ocr';
    while (!code && refreshes < ocrRefreshes) { key = await fetchCaptcha(); refreshes++; code = ocrCaptcha(captchaFile); }
    if (!code) {
      source = 'ai';
      fs.rmSync(answerFile, { force: true });
      log(`NEED_CAPTCHA ${captchaFile} -> 读图后把验证码（大小写敏感，4位）写入 ${answerFile}`);
      for (let waited = 0; !fs.existsSync(answerFile); waited++) { if (waited >= aiWaitSeconds) throw new Error('验证码等待超时'); await sleep(1000); }
      code = fs.readFileSync(answerFile, 'utf8').trim();
    }
    const envelope = await rawPost('/security/doLogin', { args: { password: encrypted, username, pictureCheckCode: code, timeout: '480', pictureCheckKey: key }, header: header(deviceId) });
    submitted++;
    if (ok(envelope)) { log(`登录成功（验证码：${source}，换图 ${refreshes} 次，提交 ${submitted} 次）`); return { token: envelope.data.accessToken, tokenName: envelope.data.tokenName, deviceId, captchaSource: source }; }
    const message = envelope.message || envelope.msg || '';
    if (!/验证码|captcha|check\s*code|verification\.code/i.test(message)) throw new Error(`登录失败：${message || envelope.code}`);
    log(`验证码被拒（${source}），重试`);
  }
  throw new Error('验证码识别连续失败');
}

// ───────── 业务接口 ─────────
export class Camel {
  constructor(session) { this.s = session; }
  headers(extra = {}) {
    return { Accept: 'application/json, text/plain, */*', Cookie: `dchktoken=${this.s.token}`, 'Menu-Name': encodeURIComponent('同业拆入'), Origin: ORIGIN, Referer: `${ORIGIN}/flowManagement/debtManagement/creditBusiness/sameIn`, deviceId: this.s.deviceId, sysNo: 'CAMEL', ...extra };
  }
  async send(path_, init) {
    // outcomeUnknown：请求可能已被服务端处理（超时、断连、5xx、响应无法解析）；业务错误则明确未生效。
    const unknown = (message, cause) => Object.assign(new Error(message, { cause }), { outcomeUnknown: true });
    let response, envelope;
    try { response = await fetch(`${ORIGIN}${path_}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(60_000) }); }
    catch (error) { throw unknown(`资金系统请求结果未知：${path_}`, error); }
    if (!response.ok) throw unknown(`资金系统请求失败 HTTP ${response.status}：${path_}`);
    try { envelope = await response.json(); } catch (error) { throw unknown(`资金系统响应无法解析：${path_}`, error); }
    if (!ok(envelope)) throw new Error(`资金系统业务错误 ${envelope.code ?? ''} ${envelope.message || envelope.msg || ''}：${path_}`.trim());
    return envelope.data;
  }
  post(p, json) { return this.send(p, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ...json, header: header(this.s.deviceId, this.s.tokenName) }) }); }
  /** 请求体即 payload 本身（不附 header），与 data/src/camel/service.ts 的 excel/data/save 一致。 */
  postBody(p, body) { return this.send(p, { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }); }
  get(p) { return this.send(p, { method: 'GET', headers: this.headers() }); }
  upload(p, bytes, name, type) { const form = new FormData(); form.set('file', new Blob([bytes], { type }), name); return this.send(p, { method: 'POST', headers: this.headers(), body: form }); }

  query(date, current = 1, size = 50) { return this.post('/camel/interbank/borrowing/query', { dateType: '0', startDate: date, endDate: date, current, size }); }
  async rows(date) {
    const rows = [], seen = new Set(), serials = new Set();
    let total;
    for (let current = 1; current <= 100; current++) {
      const page = await this.query(date, current);
      if (!Array.isArray(page.records) || !Number.isInteger(Number(page.total))) throw new Error('台账响应无效');
      if (total !== undefined && total !== Number(page.total)) throw new Error('台账分页总数已改变');
      total = Number(page.total);
      for (const row of page.records) {
        if (row.id == null || row.id === '' || !row.serialNo || seen.has(String(row.id)) || serials.has(row.serialNo)) throw new Error('台账 ID 或成交编号无效或重复');
        seen.add(String(row.id)); serials.add(row.serialNo); rows.push(row);
      }
      if (rows.length === total) return rows;
      if (!page.records.length || rows.length > total) throw new Error('台账分页不完整');
    }
    throw new Error('台账超过查询限制');
  }
  async freshRow(date, serialNo) { const row = (await this.rows(date)).find(r => r.serialNo === serialNo); if (!row) throw new Error(`台账中没有 ${serialNo}`); return row; }
  parseExcel(bytes, name) { return this.upload('/camel/interbank/borrowing/excel/parse', bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  async importRecords(records) {
    const existing = new Set((await this.rows(records[0].busiDate)).map(row => row.serialNo));
    if (records.some(row => existing.has(row.serialNo))) throw new Error('台账已存在，请重新查询导入进度');
    const check = await this.post('/camel/income/certificate/checkPublishAmount', { amount: 0 });
    if (!check.checkResult) throw new Error('资金系统额度检查未通过');
    await this.postBody('/camel/interbank/borrowing/excel/data/save', records);
  }
  attach(bytes, name) { return this.upload('/camel/file', bytes, name, 'application/pdf'); }
  draft(hid) { return this.get(`/camel/fund/transfer/fundAllocate?hid=${encodeURIComponent(hid)}`); }
  /** 草稿请求体：只做本地校验和只读查询，不写资金系统。 */
  async draftPayload(row, attachmentIds) {
    if (row.hid) throw new Error('还款草稿已存在');
    if (row.dataSource !== 'Excel上传' || !['UN_EXPIRE', 'EXPIRE'].includes(String(row.paymentStatus))) throw new Error('台账不支持创建还款草稿');
    for (const key of ['disburseAccountId', 'disburseAccount', 'disburseAccountBank', 'disburseAccountName', 'disburseAccountBranch', 'disburseAccountBranchNo']) if (row[key] == null || row[key] === '') throw new Error('台账还款账户缺失');
    if (!(Number(row.expireAmount) > 0)) throw new Error('台账还款金额缺失');
    const context = await this.post('/camel/user/getUserContext?sysNo=CAMEL', {});
    const payer = await this.get('/camel/interbank/borrowing/repay/account/info');
    return {
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
    };
  }
  saveDraft(payload) { return this.post('/camel/interbank/borrowing/repaymentAllocate/save', payload); }
}
