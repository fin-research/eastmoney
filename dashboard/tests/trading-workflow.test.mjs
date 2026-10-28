import { migrateLegacyNodes } from '../src/lib/trading-workflow/legacy.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph, timelineCursor, workflowGroups, workflowBranchFrames, nodeComplete } from '../src/lib/trading-workflow/graph.ts';
import { activeTasks, defaultFlows, nodeScope, nodeFlowIds, insertNode, reparentNode, childrenOf, dayKey, descendants, dueReminders, emptyDay, removeNode, moveNode, nodesSchema, readDay, saveSchema, shanghaiClock, updateDay } from '../src/lib/trading-workflow/model.ts';
import { readWorkflowConfig, saveWorkflowConfig } from '../src/lib/server/trading-workflow.ts';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const migration = readFileSync(new URL('../migrations/1015_trading_workflow_config.sql', import.meta.url), 'utf8');
  sqlite.exec(migration);
  const adapter = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values) ?? null; } }; } };
  return { sqlite, adapter, migration };
}
const fixture = database();
const legacyDefaults = JSON.parse(fixture.sqlite.prepare('SELECT nodes FROM trading_workflow_config').get().nodes);
const defaults = migrateLegacyNodes(legacyDefaults);
fixture.sqlite.close();
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }

test('migration seeds every product and shared instruction without progress tables; replay preserves edited config', async () => {
  const { sqlite, adapter, migration } = database();
  try {
    const initial = await readWorkflowConfig(adapter);
    assert.equal(initial.nodes.length, 26);
    assert.equal(nodesSchema.safeParse(initial.nodes).success, true);
    assert.deepEqual(initial.nodes.filter(n => nodeScope(n, initial.nodes) === 'loan').map(n => n.title), ['询价', '本币发交易', '等待成交', '导出发咚咚群', '衡泰补单审批', '资金系统导入数据 & 还款申请', '银企流水查询是否到账']);
    assert.match(initial.nodes.find(n => n.id === 'reverse-check').detail, /AAA.*− 5.*≤ 95\n.*永续.*次级.*− 10.*≤ 90/);
    assert.match(initial.nodes.find(n => n.id === 'reverse-transfer').detail, /0386 → 0432/);
    assert.match(initial.nodes.find(n => n.id === 'reverse-ccdc').detail, /0432 → 2001/);
    const edited = initial.nodes.map(n => n.id === 'loan-send' ? { ...n, title: '修改后的节点' } : n);
    const result = await saveWorkflowConfig(adapter, { expectedVersion: 1, flows: defaultFlows, nodes: edited });
    assert.equal(result.version, 2);
    sqlite.exec(migration);
    assert.deepEqual(await readWorkflowConfig(adapter), result);
    assert.deepEqual(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ['trading_workflow_config']);
    await assert.rejects(saveWorkflowConfig(adapter, { expectedVersion: 1, flows: defaultFlows, nodes: defaults }), e => e.status === 409);
    assert.deepEqual(await readWorkflowConfig(adapter), result);
  } finally { sqlite.close(); }
});

test('config rejects progress, duplicate IDs, foreign/missing parents, cycles and invalid times', () => {
  assert.equal(saveSchema.safeParse({ expectedVersion: 1, flows: defaultFlows, nodes: defaults, completed: {} }).success, false);
  assert.equal(nodesSchema.safeParse([...defaults, defaults[0]]).success, false);
  for (const patch of [{ parentId: 'absent' }, { parentId: 'loan-send' }, { startTime: '25:00' }, { startTime: '11:00', endTime: '10:00' }, { startTime: null, endTime: '12:00' }]) {
    const nodes = defaults.map(n => n.id === 'loan-send' ? { ...n, ...patch } : n);
    assert.equal(nodesSchema.safeParse(nodes).success, false, JSON.stringify(patch));
  }
  assert.equal(nodesSchema.safeParse(defaults.map(n => n.id === 'loan-send' ? { ...n, parentId: 'shared-done' } : n)).success, true, 'a multi-flow branch may contain a task from one of its flows');
  const cycle = defaults.map(n => n.id === 'reverse-counterparty' ? { ...n, parentId: 'reverse-missing' } : n);
  assert.equal(nodesSchema.safeParse(cycle).success, false);
  assert.equal(nodesSchema.safeParse(defaults.map(n => n.id === 'loan-send' ? { ...n, completed: true } : n)).success, false);
});

test('reserved node IDs and more than four nested branches are rejected', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(nodesSchema.safeParse([{ ...defaults[0], id }]).success, false);
  const nested = Array.from({ length: 5 }, (_, i) => ({ ...defaults[0], id: `branch-${i}`, kind: 'branch', nextIds: [], startTime: null, parentId: i ? `branch-${i - 1}` : null }));
  assert.equal(nodesSchema.safeParse(nested.slice(0, 4)).success, true);
  assert.equal(nodesSchema.safeParse(nested).success, false);
});

test('daily products and nested conditions determine active tasks without losing prior completion', () => {
  const day = emptyDay('2026-09-15');
  assert.deepEqual(day.enabled, { loan: true, reverse: true, exchange: false });
  assert.equal(activeTasks(defaults, day, 'loan').length, 6);
  assert.equal(activeTasks(defaults, day, 'reverse').length, 2);
  assert.equal(activeTasks(defaults, day, 'exchange').length, 0);
  day.branches['reverse-counterparty'] = true;
  day.branches['reverse-missing'] = true;
  assert.equal(activeTasks(defaults, day, 'reverse').length, 4);
  day.completed['reverse-approval'] = true;
  day.branches['reverse-counterparty'] = false;
  assert.equal(activeTasks(defaults, day, 'reverse').length, 2);
  assert.equal(day.completed['reverse-approval'], true);
  day.enabled.exchange = true;
  assert.equal(activeTasks(defaults, day, 'exchange').length, 4);
});

test('move keeps branch descendants and reorders only siblings; descendant lookup retains the entire subtree', () => {
  const moved = moveNode(defaults, 'reverse-counterparty', -1);
  assert.deepEqual(childrenOf(moved, 'reverse').map(n => n.id), ['reverse-quote', 'reverse-counterparty', 'reverse-change', 'reverse-hengtai', 'reverse-confirm']);
  assert.deepEqual([...descendants(moved, 'reverse-counterparty')].sort(), ['reverse-approval', 'reverse-check', 'reverse-counterparty', 'reverse-missing'].sort());
  assert.equal(moveNode(defaults, 'loan-quote', -1), defaults);
  assert.deepEqual(childrenOf(moved, 'reverse', 'reverse-missing'), childrenOf(defaults, 'reverse', 'reverse-missing'));
});

test('local progress survives reload, merges other tab fields, and isolates user and Shanghai midnight', () => {
  const store = storage(), date = '2026-09-15', key = dayKey('a', date);
  updateDay(store, key, date, d => { d.completed['loan-quote'] = true; });
  updateDay(store, key, date, d => { d.branches['reverse-change'] = true; });
  const restored = readDay(store, key, date);
  assert.equal(restored.completed['loan-quote'], true);
  assert.equal(restored.branches['reverse-change'], true);
  assert.deepEqual(readDay(store, dayKey('b', date), date), emptyDay(date));
  const next = shanghaiClock(new Date('2026-09-15T16:00:00Z'));
  assert.equal(next.date, '2026-09-16'); assert.equal(next.time, '00:00:00');
  assert.deepEqual(readDay(store, dayKey('a', next.date), next.date), emptyDay(next.date));
  store.setItem(key, '{broken'); assert.throws(() => readDay(store, key, date));
});

test('reminders cover exact boundaries, intervals, late wakeup, inactive branches and daily/channel dedupe', () => {
  const day = emptyDay('2026-09-15');
  const due = time => dueReminders(defaults, day, new Date(`2026-09-15T${time}+08:00`), 'browser');
  assert.equal(due('08:29:59').length, 0);
  const start = due('08:30:00'); assert.equal(start.length, 0);
  for (const item of start) day.notified[item.key] = true;
  assert.equal(due('08:30:01').length, 0);
  assert.equal(due('10:00:00').length, 1);
  day.completed['loan-quote'] = true;
  const late = due('16:30:00');
  assert.equal(late.some(item => nodeScope(item.node, defaults) === 'exchange'), false);
  assert.equal(late.some(item => item.node.id === 'loan-quote'), false);
  assert.equal(late.some(item => item.node.id === 'reverse-quote'), false, 'inquiries never require completion or reminders');
  assert.equal(late.some(item => item.node.id === 'loan-arrival'), true);
  assert.equal(dueReminders(defaults, day, new Date('2026-09-16T08:30:00+08:00'), 'browser').length, 0);
  assert.equal(dueReminders(defaults, day, new Date('2026-09-15T08:30:00+08:00'), 'page').length, 0);
  const timedBranch = defaults.map(n => n.id === 'reverse-position' ? { ...n, startTime: '09:00' } : n);
  assert.equal(dueReminders(timedBranch, day, new Date('2026-09-15T09:00:00+08:00'), 'browser').length, 0);
  day.branches['reverse-change'] = true;
  assert.equal(dueReminders(timedBranch, day, new Date('2026-09-15T09:00:00+08:00'), 'browser').length, 1);
});

test('workflow DOM interactions, local-only writes, editor conflicts and authenticated API boundaries', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=browser','tests/helpers/trading-workflow-ui.mjs'], { cwd: new URL('../',import.meta.url), timeout:60000 });
  assert.match(stdout, /Trading workflow DOM and API checks passed/);
});


test('flow graph folds conditions, centers common steps, joins paths and preserves custom offsets', () => {
  const day = emptyDay('2026-09-15');
  const options = { editing: false, selectedId: '', clockMinutes: 600, activate() {}, toggleProduct() {}, note() {} };
  const folded = buildGraph(defaults, day, options);
  assert.equal(folded.nodes.some(n => n.id === 'reverse-position'), false);
  assert.equal(folded.nodes.some(n => n.id.startsWith('product-')), false, 'classifications are not flow nodes');
  assert.equal(folded.edges.some(e => e.source.startsWith('product-')), false);
  const at = id => folded.nodes.find(n => n.id === id).position;
  assert.equal(at('shared-elements').x, (at('loan-quote').x + at('reverse-quote').x) / 2);
  assert.equal(at('shared-done').x, at('shared-elements').x);
  assert.ok(at('shared-done').y > at('loan-arrival').y);
  const foldedLoan = buildGraph(defaults, {...day,enabled:{loan:true,reverse:false,exchange:false}}, options);
  assert.ok(foldedLoan.nodes.every(n => n.data.width <= 460));
  const wide = buildGraph(defaults,day,{...options,width:2400});
  assert.ok(wide.nodes.every(n => n.data.width <= 460));
  for (const target of wide.nodes) {
    const incoming = wide.edges.filter(edge => edge.target === target.id);
    assert.equal(new Set(incoming.map(edge => edge.data.joinY)).size, incoming.length ? 1 : 0);
    for (const edge of incoming) {
      const source = wide.nodes.find(node => node.id === edge.source);
      assert.ok(target.position.y - source.position.y - source.measured.height >= 76);
      assert.ok(edge.data.joinY > source.position.y + source.measured.height);
      assert.ok(edge.data.joinY < target.position.y);
    }
  }
  assert.equal(foldedLoan.nodes.find(n => n.id === 'loan-quote').position.x, foldedLoan.nodes.find(n => n.id === 'shared-elements').position.x);
  assert.ok(at('loan-quote').y < at('shared-elements').y);
  assert.ok(at('reverse-quote').y < at('shared-elements').y);
  assert.ok(at('shared-elements').y < at('loan-send').y);
  assert.deepEqual(folded.timeline.map(mark=>mark.time), ['08:30','10:00','11:00','16:30']);
  const first=folded.timeline[0], second=folded.timeline[1];
  assert.equal(timelineCursor(folded.timeline, (first.minute + second.minute)/2), (first.y + second.y)/2);
  assert.equal(timelineCursor(folded.timeline, 0), first.y);
  assert.equal(timelineCursor([], 600), null);
  assert.ok(folded.nodes.every(node=>node.measured?.height > 0), 'flow nodes stay visible through reactive rebuilds');
  day.branches['reverse-change'] = true;
  const expanded = buildGraph(defaults, day, options);
  assert.ok(expanded.nodes.some(n => n.id === 'reverse-position'));
  for (const edge of expanded.edges) {
    assert.equal(edge.sourceHandle, edge.data.side ? 'side' : 'bottom', 'main paths must never select the side outlet');
    assert.equal(edge.targetHandle, edge.data.side ? 'side' : 'top');
  }
  assert.deepEqual(workflowBranchFrames(folded.nodes), []);
  const frame = workflowBranchFrames(expanded.nodes).find(frame => frame.id === 'reverse-change');
  assert.ok(frame);
  for (const child of expanded.nodes.filter(node => node.data.node.parentId === frame.id)) {
    assert.ok(frame.left < child.position.x && frame.top < child.position.y);
    assert.ok(frame.left + frame.width > child.position.x + child.data.width);
    assert.ok(frame.top + frame.height > child.position.y + child.measured.height);
  }
  assert.ok(expanded.edges.some(e => e.source === 'reverse-change' && e.target === 'reverse-position'));
  assert.ok(expanded.edges.some(e => e.source === 'reverse-change' && e.target === 'reverse-counterparty'));
  assert.equal(expanded.edges.some(e => e.source === 'reverse-ccdc' && e.target === 'reverse-counterparty'), false);
  assert.ok(expanded.bases['reverse-position'].x > expanded.bases['reverse-change'].x);
  assert.equal(expanded.bases['reverse-counterparty'].y, folded.bases['reverse-counterparty'].y, 'expanded branches do not push the main path down');
  const taller = buildGraph(defaults, day, {...options, heights:{'loan-send':500}});
  assert.ok(taller.nodes.find(n => n.id === 'loan-deal').position.y >= taller.nodes.find(n => n.id === 'loan-send').position.y + 528);
  const positioned = defaults.map(n => n.id === 'loan-send' ? {...n, offset:{x:85,y:-20}} : n);
  const custom = buildGraph(positioned, day, {...options, editing:true});
  assert.equal(custom.nodes.find(n => n.id === 'loan-send').position.x, custom.bases['loan-send'].x + 85);
  assert.equal(custom.nodes.find(n => n.id === 'loan-send').draggable, true);
  assert.equal(custom.bases['loan-deal'].y, expanded.bases['loan-deal'].y, 'manual offsets do not shift downstream automatic bases');
  assert.equal(folded.nodes.find(n => n.id === 'loan-send').draggable, false);
  assert.equal(nodesSchema.safeParse(positioned).success, true);
  assert.equal(nodesSchema.safeParse(defaults.map(n => ({...n,offset:{x:Infinity,y:0}}))).success, false);
});

test('legacy day records gain empty inquiry notes without losing progress; notes isolate and merge by day', () => {
  const store=storage(), date='2026-09-15', key=dayKey('notes-user',date);
  const {notes,...legacy}=emptyDay(date); legacy.completed['loan-quote']=true;
  store.setItem(key,JSON.stringify(legacy));
  assert.deepEqual(readDay(store,key,date).notes,{});
  updateDay(store,key,date,d=>{d.notes['loan-quote']='7天 1.65%';});
  updateDay(store,key,date,d=>{d.completed['loan-send']=true;});
  assert.equal(readDay(store,key,date).completed['loan-quote'],true);
  assert.equal(readDay(store,key,date).notes['loan-quote'],'7天 1.65%');
  assert.deepEqual(readDay(store,dayKey('notes-user','2026-09-16'),'2026-09-16').notes,{});
});


test('product-owned approvals stay separate, fold with their own flow, and never bridge shared nodes', () => {
  const options = { editing: false, selectedId: '', clockMinutes: 600, activate() {}, toggleProduct() {}, note() {} };
  const day = emptyDay('2026-09-15');
  assert.ok(workflowGroups(defaults).every(group => group.length === 1));
  let graph = buildGraph(defaults, day, options);
  assert.deepEqual(graph.nodes.filter(node => node.data.title === '衡泰补单审批').map(node => node.id), ['loan-hengtai', 'reverse-hengtai']);
  assert.ok(graph.edges.some(edge => edge.source === 'reverse-hengtai' && edge.target === 'reverse-confirm'));
  assert.equal(graph.edges.some(edge => edge.source === 'shared-elements' && edge.target === 'shared-done'), false);
  day.enabled.exchange = true;
  graph = buildGraph(defaults, day, options);
  assert.equal(graph.nodes.filter(node => node.data.title === '衡泰补单审批').length, 3);
  day.completed['loan-hengtai'] = true;
  graph = buildGraph(defaults, day, options);
  assert.equal(graph.nodes.find(node => node.id === 'reverse-hengtai').data.done, false);
  for (const product of ['loan', 'reverse', 'exchange']) day.enabled[product] = false;
  graph = buildGraph(defaults, day, options);
  assert.deepEqual(graph.nodes.map(node => node.id), ['shared-elements', 'shared-done']);
  day.enabled.loan = true; day.enabled.exchange = true;
  const emptyExchange = defaults.filter(node => nodeScope(node, defaults) !== 'exchange');
  graph = buildGraph(emptyExchange, day, options);
  assert.equal(graph.edges.some(edge => edge.source === 'shared-elements' && edge.target === 'shared-done'), false, 'empty flow adds no shared shortcut');
});

test('shared branches have a separate right rail even with all products folded', () => {
  const branch = { id: 'common-branch', flowIds: ['loan', 'reverse', 'exchange'], nextIds: ['common-child'], parentId: null, kind: 'branch', title: '共通条件', detail: '', startTime: null, endTime: null };
  const child = { ...branch, id: 'common-child', nextIds: [], parentId: branch.id, kind: 'task' };
  const day = emptyDay('2026-09-15');
  day.enabled = { loan: false, reverse: false, exchange: false };
  day.branches[branch.id] = true;
  const graph = buildGraph([branch, child], day, { editing: false, selectedId: '', clockMinutes: 0, activate() {}, toggleProduct() {}, note() {} });
  const root = graph.nodes.find(node => node.id === branch.id), side = graph.nodes.find(node => node.id === child.id);
  assert.ok(side.position.x > root.position.x + root.width);
  assert.ok(side.position.x + side.width <= graph.width);
});

test('deleting one branch promotes its children in order and persists both deletion and icons', async () => {
  const { sqlite, adapter } = database();
  try {
    let nodes = removeNode(defaults, 'reverse-counterparty');
    assert.equal(nodes.some(node => node.id === 'reverse-counterparty'), false);
    assert.equal(nodes.find(node => node.id === 'reverse-missing').parentId, null);
    assert.equal(nodes.find(node => node.id === 'reverse-check').parentId, null);
    assert.equal(nodes.find(node => node.id === 'reverse-approval').parentId, 'reverse-missing');
    assert.deepEqual(childrenOf(nodes, 'reverse').map(node => node.id), ['reverse-quote', 'reverse-change', 'reverse-check', 'reverse-missing', 'reverse-hengtai', 'reverse-confirm']);
    nodes = removeNode(nodes, 'reverse-missing');
    nodes = nodes.map(node => node.id === 'reverse-approval' ? { ...node, icon: 'clipboard-check' } : node);
    const saved = await saveWorkflowConfig(adapter, saveSchema.parse({ expectedVersion: 1, flows: defaultFlows, nodes }));
    assert.deepEqual(await readWorkflowConfig(adapter), saved);
    assert.equal(saved.nodes.find(node => node.id === 'reverse-approval').parentId, null);
    assert.equal(saved.nodes.find(node => node.id === 'reverse-approval').icon, 'clipboard-check');
    assert.equal(nodesSchema.safeParse([{ ...defaults[0], icon: 'unregistered' }]).success, false);
    assert.deepEqual(removeNode([{ ...defaults[0], parentId: null }], defaults[0].id), []);
  } finally { sqlite.close(); }
});

test('branch completion requires every descendant, including collapsed nested branches', () => {
  const day = emptyDay('2026-09-15');
  const parent = defaults.find(node => node.id === 'reverse-counterparty');
  assert.equal(nodeComplete(parent, defaults, day), false);
  day.completed['reverse-check'] = true;
  assert.equal(nodeComplete(parent, defaults, day), false);
  day.completed['reverse-approval'] = true;
  assert.equal(nodeComplete(parent, defaults, day), true);
  day.branches['reverse-counterparty'] = false;
  assert.equal(nodeComplete(parent, defaults, day), true);
  const differentParents = defaults.map(node => node.id === 'reverse-hengtai' ? {...node, parentId:'reverse-counterparty'} : node);
  assert.equal(workflowGroups(differentParents).find(group => group[0].id === 'reverse-hengtai').length, 1);
});


test('explicit successors determine order independently of array order and time; merge is automatic', () => {
  const make = (id, nextIds, flowIds = ['loan']) => ({ ...defaults[0], id, title: id, startTime: null, flowIds, nextIds });
  const nodes = [make('a', ['c']), make('b', ['c'], ['reverse']), make('c', ['d']), make('d', [])];
  assert.equal(nodesSchema.safeParse(nodes).success, true);
  assert.equal(nodeScope(nodes[2], nodes), 'shared');
  assert.deepEqual(nodeFlowIds(nodes[2], nodes), ['loan', 'reverse']);
  const options = { editing: true, selectedId: '', clockMinutes: 0, activate() {}, toggleProduct() {}, note() {} };
  for (const input of [nodes, [...nodes].reverse()]) {
    const graph = buildGraph(input, emptyDay('2026-09-15'), options);
    assert.deepEqual(graph.edges.map(edge => `${edge.source}:${edge.target}`).sort(), ['a:c', 'b:c', 'c:d']);
    assert.ok(graph.bases.d.y > graph.bases.c.y);
    assert.equal(graph.nodes.filter(node => node.id === 'c').length, 1);
  }
  for (const nextIds of [['missing'], ['c', 'c'], ['a']]) assert.equal(nodesSchema.safeParse(nodes.map(node => node.id === 'a' ? { ...node, nextIds } : node)).success, false);
  assert.equal(nodesSchema.safeParse(nodes.map(node => node.id === 'd' ? { ...node, nextIds: ['a'] } : node)).success, false);
  const swapped = moveNode(defaults, 'loan-deal', -1);
  assert.ok(swapped.find(node => node.id === 'shared-elements').nextIds.includes('loan-deal'));
  assert.deepEqual(swapped.find(node => node.id === 'loan-deal').nextIds, ['loan-send']);
  assert.deepEqual(swapped.find(node => node.id === 'loan-send').nextIds, ['loan-export']);
  assert.equal(nodesSchema.safeParse(swapped).success, true);
  const inserted = insertNode(nodes, nodes[2], make('new', []));
  assert.deepEqual(inserted.find(node => node.id === 'c').nextIds, ['new']);
  assert.deepEqual(inserted.find(node => node.id === 'new').nextIds, ['d']);
  const removed = removeNode(nodes, 'c');
  assert.deepEqual(removed.map(node => node.nextIds), [['d'], ['d'], []]);
  assert.equal(nodesSchema.safeParse(removed).success, true);
});

test('graph migration preserves edited legacy data and is idempotent; flow and node JSON are separate', async () => {
  const { sqlite, adapter } = database();
  try {
    const legacy = legacyDefaults.map(node => node.id === 'loan-send' ? { ...node, title: '保留人工编辑', offset: { x: 42, y: 0 }, icon: 'send' } : node);
    sqlite.prepare('UPDATE trading_workflow_config SET nodes = ?').run(JSON.stringify(legacy));
    const sql = readFileSync(new URL('../migrations/1016_trading_workflow_graph.sql', import.meta.url), 'utf8');
    sqlite.exec(sql);
    const saved = await readWorkflowConfig(adapter);
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.flows, defaultFlows);
    const normalize = nodes => nodes.map(node => ({ ...node, nextIds: [...node.nextIds].sort() }));
    assert.deepEqual(normalize(saved.nodes), normalize(migrateLegacyNodes(legacy)));
    assert.ok(saved.nodes.every(node => !('scope' in node)));
    sqlite.exec(sql);
    assert.deepEqual(await readWorkflowConfig(adapter), saved);
    const persisted = await saveWorkflowConfig(adapter, { expectedVersion: saved.version, flows: saved.flows, nodes: moveNode(saved.nodes, 'loan-deal', -1) });
    assert.deepEqual(await readWorkflowConfig(adapter), persisted);
    assert.equal(Array.isArray(JSON.parse(sqlite.prepare('SELECT nodes FROM trading_workflow_config').get().nodes)), false);
  } finally { sqlite.close(); }
});


test('moving a step into a condition reconnects its former path and inserts it before the condition children', () => {
  const moved = reparentNode(defaults, 'reverse-hengtai', 'reverse-change');
  assert.equal(nodesSchema.safeParse(moved).success, true);
  assert.ok(moved.find(node => node.id === 'reverse-counterparty').nextIds.includes('reverse-confirm'));
  assert.ok(moved.find(node => node.id === 'reverse-change').nextIds.includes('reverse-hengtai'));
  assert.deepEqual(moved.find(node => node.id === 'reverse-hengtai').nextIds, ['reverse-position']);
  assert.equal(moved.find(node => node.id === 'reverse-hengtai').parentId, 'reverse-change');
});
