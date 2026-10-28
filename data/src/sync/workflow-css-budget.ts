import { CssResponseArchiveError, saveCssResponse } from './css-response-evidence.ts';
import { createHash } from 'node:crypto';
import type { WorkflowStep } from 'cloudflare:workers';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { cssIsolationPoints } from './choice-css-batch.ts';
import { CssQuotaSnapshotError, requestCssQuota } from './choice-css-quota.ts';
import { requireBondBudget } from './bond-history-sync.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';

export const WORKFLOW_CSS_BUDGET = {
  equity: 104,
  issuance: cssIsolationPoints(64, 1, 64) + cssIsolationPoints(64, 4, 64) + cssIsolationPoints(200, 2, 100),
  history: cssIsolationPoints(6000, 3, 200),
};
type Caps = Record<string, number>;
type Snapshot = { capturedAt: string; reservations: Caps; rawJson: string | null; error?: string };
type Bucket = Pick<R2Bucket, 'list' | 'put'>;

/** One persisted preflight per Workflow, independent disjoint reservations, immutable paid intents. */
export function workflowCssBudget(step: Pick<WorkflowStep, 'do'>, bucket: Bucket, instanceId: string,
  request: DataApiRequest, quotaDate: string, reservations: Caps = WORKFLOW_CSS_BUDGET,
  now: () => number = Date.now) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instanceId) || !Object.keys(reservations).length
    || Object.entries(reservations).some(([key, value]) => !/^[a-z]+$/.test(key) || !Number.isSafeInteger(value) || value <= 0))
    throw Error('Invalid Workflow CSS reservation');
  const total = Object.values(reservations).reduce((sum, value) => sum + value, 0);
  // Schedule at Workflow scope, never nest step.do inside a paid business callback.
  const snapshot: Promise<Snapshot> = step.do('读取本流程共享CSS额度',
    { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' }, async (): Promise<Snapshot> => {
      try {
        const raw = await requestCssQuota(request);
        requireBondBudget(raw, quotaDate, total);
        return { rawJson: JSON.stringify(raw), reservations, capturedAt: new Date(now()).toISOString() };
      } catch (error) {
        return { rawJson: null, reservations, capturedAt: new Date(now()).toISOString(), error: economicIndicatorErrorDetails(error).message };
      }
    });
  void snapshot.catch(() => undefined);
  const clients = new Map<string, DataApiRequest>();
  return (group: string): DataApiRequest => {
    if (!reservations[group]) throw Error('Unreserved Workflow CSS group');
    if (clients.has(group)) return clients.get(group)!;
    const prefix = `data-observations/css-budget/${instanceId}/${group}/`;
    let spent = 0, initialized: Promise<void> | undefined;
    const initialize = () => initialized ??= (async () => {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, include: ['customMetadata'], limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) {
          const points = Number(object.customMetadata?.points);
          if (!Number.isSafeInteger(points) || points <= 0) throw Error('Invalid persisted CSS intent');
          spent += points;
        }
        if (page.truncated && !page.cursor) throw Error('Incomplete persisted CSS intent listing');
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    })();
    const client: DataApiRequest = async (path, parameters) => {
      if (path !== '/choice/css' && path !== '/choice/data-statistics') return request(path, parameters);
      if (path === '/choice/data-statistics' && parameters.get('funcName') !== 'EM_CSS')
        throw Error('Unexpected shared quota function');
      const quota = await snapshot;
      if (JSON.stringify(quota.reservations) !== JSON.stringify(reservations)) throw Error('Persisted CSS reservations changed');
      if (quota.error) throw new CssQuotaSnapshotError(quota.error);
      const age = now() - Date.parse(quota.capturedAt);
      if (!Number.isFinite(age) || age < 0 || age > 15 * 60000) throw new CssQuotaSnapshotError('Workflow CSS quota snapshot expired');
      const raw: unknown = JSON.parse(quota.rawJson!);
      requireBondBudget(raw, quotaDate, total);
      if (path === '/choice/data-statistics') {
        console.log(JSON.stringify({ event: 'workflow_css_quota_reused', instanceId, group, capturedAt: quota.capturedAt }));
        return raw;
      }
      const codes = (parameters.get('codes') ?? '').split(',');
      const fields = (parameters.get('indicators') ?? '').split(',');
      if (codes.some(code => !code.trim()) || fields.some(field => !field.trim())) throw Error('Empty CSS budget dimension');
      const points = codes.length * fields.length;
      await initialize();
      if (spent + points > quota.reservations[group]!) throw Error('Workflow CSS group budget exhausted');
      spent += points; // Reserve synchronously before the R2 await, including failed/unknown execution.
      const bytes = JSON.stringify({ path, parameters: [...parameters.entries()]
        .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)) });
      const sha = createHash('sha256').update(bytes).digest('hex');
      const intentKey = prefix + sha + '.json';
      const saved = await bucket.put(intentKey, JSON.stringify({
        instanceId, group, createdAt: new Date(now()).toISOString(), points, request: JSON.parse(bytes), quotaCapturedAt: quota.capturedAt,
      }), { onlyIf: new Headers({ 'If-None-Match': '*' }), customMetadata: { points: String(points) },
        httpMetadata: { contentType: 'application/json' } });
      if (!saved) { spent -= points; throw Error('CSS intent already exists; refusing paid replay'); }
      console.log(JSON.stringify({ event: 'workflow_css_intent', instanceId, group, points, spent,
        reserved: quota.reservations[group], requestSha256: sha }));
      if (group !== 'history') return request(path, parameters);
      let captured = false;
      let value: unknown;
      try {
        value = await request(path, parameters, async evidence => {
          await saveCssResponse(bucket, intentKey, JSON.parse(bytes), evidence);
          captured = true;
        });
      } catch (error) {
        if (!captured) throw new CssResponseArchiveError();
        throw error;
      }
      if (!captured) throw new CssResponseArchiveError();
      return value;
    };
    clients.set(group, client);
    return client;
  };
}
