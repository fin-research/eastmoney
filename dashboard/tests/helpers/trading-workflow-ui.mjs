import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { installDom } from './svelte-dom.mjs';
import { loadWorkflowView } from './workflow-bundle.mjs';
const window = installDom();
// This harness checks settled DOM/state contracts. Real 240ms motion is covered
// by Playwright; happy-dom schedules rAF with setImmediate instead of paint frames.
window.happyDOM.settings.device.prefersReducedMotion = 'reduce';
// happy-dom rejects animation.finished during cancellation without the browser's
// handled-promise behavior; observe that promise while retaining real transitions.
const nativeAnimate = window.HTMLElement.prototype.animate;
window.HTMLElement.prototype.animate = function (...args) {
  const animation = nativeAnimate.apply(this, args);
  animation.finished.catch(() => {});
  return animation;
};
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
let lockTail = Promise.resolve();
let lockGate = Promise.resolve();
Object.defineProperty(navigator, 'locks', { value: { request(_name, run) { const next = lockTail.then(() => lockGate).then(run); lockTail = next.catch(() => {}); return next; } }, configurable: true });
const nativeDate = Date;
let fixed = new nativeDate('2026-09-15T11:00:00+08:00').getTime();
class Clock extends nativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
globalThis.Date = Clock;
const notices = [];
class Notification { static permission = 'default'; static async requestPermission() { this.permission = 'granted'; return this.permission; } constructor(title, options) { notices.push({title,...options}); } close() {} }
globalThis.Notification = window.Notification = Notification;
if (!window.HTMLDialogElement.prototype.showModal) window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
const { mount, unmount, flushSync } = await import('svelte');
const { globalMessages } = await import('../../src/lib/global-messages.ts');
const { dayKey, emptyDay, defaultFlows } = await import('../../src/lib/trading-workflow/model.ts');
const db = new DatabaseSync(':memory:');
db.exec(await readFile(new URL('../../migrations/1015_trading_workflow_config.sql',import.meta.url),'utf8'));
const { migrateLegacyNodes } = await import('../../src/lib/trading-workflow/legacy.ts');
let config = { version: 1, flows: defaultFlows, nodes: migrateLegacyNodes(JSON.parse(db.prepare('SELECT nodes FROM trading_workflow_config').get().nodes)) };
const requests = [];
let conflict = false;
let serverDay = null;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, ...options });
  if(url === '/api/trading-workflow/day') {
    if(options.method === 'PUT') {
      const patch=JSON.parse(options.body),old=serverDay ?? emptyDay(patch.date);
      serverDay={...old,enabled:{...old.enabled,...patch.enabled},completed:{...old.completed,...patch.completed},branches:{...old.branches,...patch.branches}};
    }
    return Response.json({state:serverDay ?? emptyDay('2026-09-15'),revision:serverDay?1:0});
  }
  if (url === '/data/chinamoney/shibor') return Response.json([{publishDate:'2026-09-15',publishedAt:'2026-09-15T11:00:00+08:00',tenor:'1W',rate:1.5}]);
  if (options.method === 'PUT') {
    if (conflict) return Response.json({error:'节点配置已被更新，请重新载入后修改'},{status:409});
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['expectedVersion','flows','nodes']);
    config = {version: config.version+1, flows:body.flows, nodes:body.nodes};
    return Response.json(config);
  }
  return Response.json({...config, actorKey:'test-actor',canEdit:true});
};
const View = await loadWorkflowView();
const header=document.createElement('header'); header.id='tr-topbar-actions'; document.body.append(header);
const target=document.createElement('main'); document.body.append(target);
const app = mount(View,{target});
async function settle() { for(let i=0;i<12;i++){await new Promise(resolve=>setTimeout(resolve,0));flushSync();} }
await settle();
const button = text => [...document.querySelectorAll('button')].find(node=>node.textContent.trim() === text);
assert.ok(document.querySelector('[aria-label="展开交易所回购"]'));
assert.ok(header.querySelector('.edit-mode'));
assert.equal(target.querySelector('.flow-toolbar'),null);
assert.equal(target.querySelector('.svelte-flow__controls'),null);
assert.equal(target.querySelector('h2'),null);
assert.equal(target.querySelector('.svelte-flow__attribution'), null);
assert.match(header.querySelector('time').textContent, /11:00:00/);
const initialCursor = target.querySelector('.current-time-line').getAttribute('y1');
fixed += 30 * 60 * 1000; window.dispatchEvent(new window.Event('focus')); await settle();
assert.match(header.querySelector('time').textContent, /11:30:00/);
assert.ok(Number(target.querySelector('.current-time-line').getAttribute('y1')) > Number(initialCursor));
fixed -= 30 * 60 * 1000; window.dispatchEvent(new window.Event('focus')); await settle();
assert.equal(document.querySelector('.inquiry'), null);
assert.equal(document.querySelectorAll('.product-toggle').length, 3);
const originalIcon = document.querySelector('[data-workflow-node="loan-deal"] .node-symbol').innerHTML;
assert.deepEqual([...target.querySelectorAll('[data-timeline-time]')].map(n=>n.dataset.timelineTime),['08:30','10:00','11:00','16:30']);
assert.equal(document.querySelector('[data-workflow-product="exchange"]'), null);
assert.equal(document.querySelector('[data-id="product-loan"]'), null);
assert.equal(document.querySelector('[data-workflow-node="reverse-position"]'), null);
assert.equal(document.querySelector('[data-workflow-node="loan-deal"] input'), null, 'nodes have no checkbox controls');
const clickNode = async id => { flushSync(() => document.querySelector(`[data-workflow-node="${id}"] .node-surface`).click()); await settle(); };
await clickNode('reverse-change');
assert.ok(document.querySelector('[data-workflow-node="reverse-position"]'));
await clickNode('reverse-position');
await clickNode('reverse-change');
assert.equal(document.querySelector('[data-workflow-node="reverse-position"]'), null);
await clickNode('reverse-change');
assert.equal(document.querySelector('[data-workflow-node="reverse-position"] button').getAttribute('aria-pressed'), 'true');
assert.equal(document.querySelector('[data-workflow-node="reverse-change"]').classList.contains('done'), false);
await clickNode('reverse-transfer'); await clickNode('reverse-ccdc');
assert.equal(document.querySelector('[data-workflow-node="reverse-change"]').classList.contains('done'), true);
await clickNode('loan-deal');
assert.equal(document.querySelector('[data-workflow-node="loan-deal"] .node-symbol').innerHTML, originalIcon);
await clickNode('loan-quote');
const table = () => document.querySelector('[data-workflow-node="loan-quote"] .inquiry-table');
assert.ok(table().querySelector('[aria-label="在此行下方插入询价"]'));
assert.equal(table().querySelector('th'),null);
assert.equal(document.querySelector('[data-workflow-node="loan-quote"] .node-surface').hasAttribute('aria-pressed'), false);
const fill = async (field, value) => {
  const input = table().querySelector(`.inquiry-row:last-child [data-field="${field}"]`);
  input.focus(); flushSync(()=>{input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  assert.equal(document.activeElement.dataset.field, field, 'typing retains focus before async persistence');
  await settle(); return document.activeElement;
};
const tabKey = async () => { const input=document.activeElement; flushSync(()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))); await settle(); };
await fill('counterparty','工商银行'); assert.equal(table().querySelectorAll('.inquiry-row').length,1,'first value does not append a row'); await tabKey();
async function typeActive(value) { const input=document.activeElement; flushSync(()=>{input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle(); }
await typeActive('张三'); await tabKey(); await typeActive('3'); await tabKey(); await typeActive('1.5'); await tabKey(); await typeActive('10'); await tabKey();
assert.equal(document.activeElement.dataset.field,'counterparty');
await typeActive('gsyh'); await tabKey();
assert.equal(table().querySelectorAll('[data-field="counterparty"]')[1].value,'工商银行');
await typeActive('zs'); await tabKey();
assert.equal(document.activeElement.value,'','numeric suggestion is not a value');
assert.equal(table().querySelector(`[id="choices-${document.activeElement.dataset.row}-${document.activeElement.dataset.field}"] [role=option]`).textContent,'3');
await tabKey(); await tabKey(); await tabKey();
const local = JSON.parse(localStorage.getItem(dayKey('test-actor','2026-09-15')));
assert.equal(local.completed['loan-deal'],true); assert.equal(local.completed['loan-quote'],undefined);
assert.equal(local.quotes['loan-quote'].length,2);
assert.deepEqual(local.quotes['loan-quote'].map(({id,...row})=>row),Array(2).fill({counterparty:'工商银行',trader:'张三',tenor:'3',amount:'1.5',price:'10'}));
assert.equal(table().querySelector('[data-field="price"]').value,'1.4000%');
await clickNode('reverse-quote');
const reverse = document.querySelector('[data-workflow-node="reverse-quote"] .inquiry-table');
assert.equal(reverse.querySelector('[data-field="trader"]'),null);
assert.equal(reverse.querySelectorAll('input').length,4);
let releaseLock;
lockGate = new Promise(resolve => releaseLock = resolve);
const counterparty = reverse.querySelector('[data-field="counterparty"]');
counterparty.focus();
flushSync(()=>{counterparty.value='招商银行';counterparty.dispatchEvent(new window.Event('input',{bubbles:true}));});await settle();
counterparty.blur();
window.dispatchEvent(new window.StorageEvent('storage',{key:dayKey('test-actor','2026-09-15')}));await settle();
assert.equal(reverse.querySelector('[data-field="counterparty"]').value,'招商银行','pending optimistic rows survive stale storage refresh after blur');
releaseLock(); await settle();
assert.equal(JSON.parse(localStorage.getItem(dayKey('test-actor','2026-09-15'))).quotes['reverse-quote'][0].counterparty,'招商银行');

flushSync(() => document.querySelector('[aria-label="展开交易所回购"]').click()); await settle();
assert.ok(document.querySelector('[data-workflow-node="exchange-o32"]'));
flushSync(() => document.querySelector('[aria-label="折叠交易所回购"]').click()); await settle();
assert.equal(document.querySelector('[data-workflow-node="exchange-o32"]'), null);
assert.ok(requests.some(request=>request.url==='/api/trading-workflow/day'&&request.method==='PUT'),'scheduling flags are synced for background reminders');
assert.ok(requests.filter(request=>request.url==='/api/trading-workflow/day'&&request.method==='PUT').every(request=>!('quotes' in JSON.parse(request.body))),'inquiry rows remain local');
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
assert.equal(document.querySelector('.workflow-editor'), null, 'editing starts on the graph; panel opens on node click');
await clickNode('shared-elements');
assert.ok(document.querySelector('.workflow-editor'));
assert.equal(notices.length,0,'notifications are delivered by the service worker, not the foreground page');
assert.equal(JSON.parse(localStorage.getItem(dayKey('test-actor','2026-09-15'))).completed['shared-elements'], undefined, 'editing does not complete nodes');
const name=document.querySelector('.editor-fields input');
flushSync(()=>{name.value='修改后的协同节点';name.dispatchEvent(new window.Event('input',{bubbles:true}));}); await settle();
// Coordinate inputs provide a keyboard/pointer alternative to direct graph dragging.
document.querySelector('.editor-advanced').open = true;
const position = document.querySelector('.editor-fields input[type="number"]');
flushSync(()=>{position.value='120'; position.dispatchEvent(new window.Event('input',{bubbles:true}));}); await settle();
window.confirm = () => false;
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
assert.equal(document.querySelector('.edit-mode [role=checkbox]').getAttribute('aria-checked'), 'true', 'declining discard keeps the mode switch on');
assert.ok(document.querySelector('.workflow-editor'));
conflict=true;
flushSync(()=>button('保存').click()); await settle();
assert.ok(document.querySelector('.workflow-editor')); assert.equal(name.value,'修改后的协同节点');
conflict=false;
flushSync(()=>button('保存').click()); await settle();
assert.equal(document.querySelector('.workflow-editor'),null); assert.equal(config.nodes[0].title,'修改后的协同节点');
assert.deepEqual(config.nodes[0].offset, {x:120,y:0});
// Editing rewires saved successors, rejects cycles, and preserves the shared node ID.
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
await clickNode('loan-deal');
assert.ok([...document.querySelectorAll('legend')].some(node => node.textContent === '所属流程'));
assert.equal(document.querySelector('.workflow-editor').textContent.includes('节点归属'), false);
flushSync(()=>button('上移').click()); await settle();
const addNext = document.querySelector('[aria-label="添加后续节点"]');
flushSync(()=>{ addNext.value='shared-elements'; addNext.dispatchEvent(new window.Event('change',{bubbles:true})); }); await settle();
flushSync(()=>button('保存').click()); await settle();
assert.ok(config.nodes.find(node => node.id === 'shared-elements').nextIds.includes('loan-deal'));
assert.deepEqual(config.nodes.find(node => node.id === 'loan-deal').nextIds, ['loan-send']);
assert.ok(config.nodes.every(node => !('scope' in node)));
// Deletion saves immediately, retains children, and failed writes remain retryable.
window.confirm = () => true;
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
await clickNode('reverse-counterparty');
conflict = true;
flushSync(()=>button('删除节点').click()); await settle();
assert.ok(document.querySelector('.workflow-editor'));
assert.ok(config.nodes.some(node => node.id === 'reverse-counterparty'), 'conflict does not mutate saved config');
conflict = false;
flushSync(()=>button('保存').click()); await settle();
assert.equal(config.nodes.some(node => node.id === 'reverse-counterparty'), false);
assert.equal(config.nodes.find(node => node.id === 'reverse-check').parentId, null);
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
await clickNode('loan-send');
document.querySelector('.editor-advanced').open = true;
flushSync(()=>document.querySelector('.icon-options [aria-label="审批"]').click()); await settle();
flushSync(()=>button('保存').click()); await settle();
assert.equal(config.nodes.find(node => node.id === 'loan-send').icon, 'clipboard-check');
flushSync(()=>document.querySelector('.edit-mode [role=checkbox]').click()); await settle();
await clickNode('reverse-missing');
const writesBeforeDelete = requests.filter(request => request.method === 'PUT').length;
flushSync(()=>button('删除节点').click()); await settle();
assert.equal(requests.filter(request => request.method === 'PUT').length, writesBeforeDelete + 1);
assert.equal(config.nodes.find(node => node.id === 'reverse-approval').parentId, null);
assert.equal(document.querySelector('.workflow-editor'), null);
// A corrupted record in another tab must not erase this tab's existing completed work.
localStorage.setItem(dayKey('test-actor','2026-09-15'),'{broken');
window.dispatchEvent(new window.StorageEvent('storage',{key:dayKey('test-actor','2026-09-15')}));await settle();
assert.equal(document.querySelector('[data-workflow-node="loan-deal"] button').getAttribute('aria-pressed'),'true');
await unmount(app);globalMessages.clear();
assert.equal(header.children.length,0,'header portal is cleaned on route unmount');
localStorage.setItem(dayKey('test-actor','2026-09-15'),JSON.stringify(local));
const reloaded=mount(View,{target});await settle();
assert.equal(document.querySelector('[data-workflow-node="reverse-counterparty"]'), null);
assert.equal(document.querySelector('[data-workflow-node="reverse-missing"]'), null);
assert.ok(document.querySelector('[data-workflow-node="reverse-approval"]'));
assert.ok(document.querySelector('[data-workflow-node="loan-send"] .lucide-clipboard-check'));
assert.equal(document.querySelector('[data-workflow-node="loan-deal"] button').getAttribute('aria-pressed'),'true');
await clickNode('loan-quote');
assert.equal(document.querySelector('[data-workflow-node="loan-quote"] [data-field="counterparty"]').value, '工商银行');
for (const product of ['loan', 'reverse']) { flushSync(()=>document.querySelector(`[aria-label="折叠${product === 'loan' ? '拆借' : '逆回购'}"]`).click()); await settle(); }
assert.equal(document.querySelector('[data-workflow-node="shared-elements"] button').disabled, false);
assert.equal(document.querySelector('[data-workflow-node="shared-done"] button').disabled, false);
await unmount(reloaded);globalMessages.clear();

// Real route handlers, no authentication bypass or network calls.
const { GET, PUT } = await import('../../src/routes/api/trading-workflow/config/+server.ts');
const adapter={prepare(sql){let values=[];return{bind(...args){values=args;return this;},async first(){return db.prepare(sql).get(...values)??null;}};}};
const event=(permissions,body,origin='https://eastmoney.hasbai.xyz')=>({locals:{user:permissions?{id:'test-actor',authorization:{permissions}}:null},platform:{env:{DB:adapter}},request:new Request('https://eastmoney.hasbai.xyz/api/trading-workflow/config',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)})});
assert.equal((await GET(event(null))).status,401);
assert.equal((await GET(event([]))).status,403);
assert.equal((await GET(event(['research.workspace:read']))).status,200);
const valid={expectedVersion:1,flows:config.flows,nodes:config.nodes};
assert.equal((await PUT(event(['research.workspace:read'],valid))).status,403);
assert.equal((await PUT(event(['research.workflow:update'],valid,'https://evil.invalid'))).status,403);
assert.equal((await PUT(event(['research.workflow:update'],{...valid,progress:emptyDay('2026-09-15')}))).status,400);
assert.equal((await PUT(event(['research.workflow:update'],valid))).status,200);
const stale=await PUT(event(['research.workflow:update'],valid));assert.equal(stale.status,409);assert.equal((await stale.json()).code,'WORKFLOW_CONFIG_CONFLICT');
db.exec("UPDATE trading_workflow_config SET nodes='[]',version=2");
assert.equal((await GET(event(['research.workspace:read']))).status,200);
db.close();globalThis.Date=nativeDate;await window.happyDOM.abort();
console.log('Trading workflow DOM and API checks passed');
