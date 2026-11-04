import { CssResponseArchiveError, saveCssResponse } from './css-response-evidence.ts';
import { createHash } from 'node:crypto';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { cssIsolationPoints } from './choice-css-batch.ts';

export const WORKFLOW_CSS_BUDGET = {
  equity: 104,
  issuance: cssIsolationPoints(64, 1, 64) + cssIsolationPoints(64, 4, 64) + cssIsolationPoints(200, 2, 100),
  history: cssIsolationPoints(6000, 3, 200),
};
type Caps = Record<string, number>;
type Bucket = Pick<R2Bucket, 'list' | 'put'>;

/** Code-declared point caps per group and an immutable intent before each paid call. Reads no live Choice quota. */
export function workflowCssBudget(bucket: Bucket, instanceId: string,
  request: DataApiRequest, reservations: Caps = WORKFLOW_CSS_BUDGET,
  now: () => number = Date.now) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instanceId) || !Object.keys(reservations).length
    || Object.entries(reservations).some(([key, value]) => !/^[a-z]+$/.test(key) || !Number.isSafeInteger(value) || value <= 0))
    throw Error('Invalid Workflow CSS reservation');
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
      if (path === '/choice/data-statistics') throw Error('Workflows never read Choice quota');
      if (path !== '/choice/css') return request(path, parameters);
      const codes = (parameters.get('codes') ?? '').split(',');
      const fields = (parameters.get('indicators') ?? '').split(',');
      if (codes.some(code => !code.trim()) || fields.some(field => !field.trim())) throw Error('Empty CSS budget dimension');
      const points = codes.length * fields.length;
      await initialize();
      if (spent + points > reservations[group]!) throw Error('Workflow CSS group budget exhausted');
      spent += points; // Reserve synchronously before the R2 await, including failed/unknown execution.
      const bytes = JSON.stringify({ path, parameters: [...parameters.entries()]
        .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)) });
      const sha = createHash('sha256').update(bytes).digest('hex');
      const intentKey = prefix + sha + '.json';
      const saved = await bucket.put(intentKey, JSON.stringify({
        instanceId, group, createdAt: new Date(now()).toISOString(), points, request: JSON.parse(bytes),
      }), { onlyIf: new Headers({ 'If-None-Match': '*' }), customMetadata: { points: String(points) },
        httpMetadata: { contentType: 'application/json' } });
      if (!saved) { spent -= points; throw Error('CSS intent already exists; refusing paid replay'); }
      console.log(JSON.stringify({ event: 'workflow_css_intent', instanceId, group, points, spent,
        reserved: reservations[group], requestSha256: sha }));
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
