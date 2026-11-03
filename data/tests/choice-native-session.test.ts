import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This suite uses synthetic protocol frames and never opens a socket or fetches.
// Absolute imports let this draft run outside the repository; use ../src/... when copied.
const offline = vi.hoisted(() => ({
  exchange: vi.fn(),
  encodeQuery: vi.fn(),
  decodeQuery: vi.fn(),
  statistics: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(protected ctx: unknown, protected env: unknown) {}
  },
}));

vi.mock('../src/choice/native/transport.ts', () => {
  class ChoiceTransportError extends Error {
    constructor(message: string, readonly timeout = false, readonly upstreamCode?: number) {
      super(message);
      this.name = 'ChoiceTransportError';
    }
  }
  return {
    ChoiceTransportError,
    exchange: offline.exchange,
    // The session holds no socket of its own; constructing one means a heartbeat came back.
    ChoiceConnection: class { constructor() { throw new Error('No Choice socket expected in session tests'); } },
    async readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > limit) throw new ChoiceTransportError('Choice decoded payload exceeds limit');
          chunks.push(part.value);
        }
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result;
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
});

vi.mock('../src/choice/native/query.ts', () => ({
  encodeQuery: offline.encodeQuery,
  decodeQuery: offline.decodeQuery,
}));
vi.mock('../src/choice/native/statistics.ts', () => ({
  fetchNativeStatistics: offline.statistics,
}));

import { ChoiceSession } from '../src/choice/native/session.ts';
import { ChoiceTransportError, type NativeFrame } from '../src/choice/native/transport.ts';

const BASE_TIME = 1_800_000_000_000;
const encoder = new TextEncoder();
const table = { function: 'CSS', fields: ['code', 'RATE'], rows: [{ code: 'TEST.IB', RATE: 1.5 }] };
let now = BASE_TIME;

function frame(type = 1, extra = 0, body = new Uint8Array()): NativeFrame {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(1, 13 + body.length, true);
  header[6] = type;
  header[12] = extra;
  return { header, body };
}

function loginFrame(code: string | number = '0'): NativeFrame {
  return frame(3, 0, encoder.encode(JSON.stringify({
    Code: code,
    Data: { BaseInfo: {
      UniqueId: 'fixture-uid', Token: 'fixture-live-token', SessionID: 'fixture-session',
      Ctoken: 'fixture-rolled-ctoken', Utoken: 'fixture-rolled-utoken',
    } },
  })));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly get = vi.fn(async <T>(key: string): Promise<T | undefined> => this.values.get(key) as T | undefined);
  readonly put = vi.fn(async (key: string, value: unknown) => { this.values.set(key, value); });
  readonly delete = vi.fn(async (key: string) => this.values.delete(key));
}

function createSession(storage = new MemoryStorage(), account = 'fixture-account'): { session: ChoiceSession; storage: MemoryStorage } {
  const servers = Object.fromEntries(['3', '6', '19', '20'].map(type => [type, { hostname: 'fixture.invalid', port: Number(type) }]));
  const env = {
    CHOICE_SERVERS: JSON.stringify({ ...servers, statisticsOrigin: 'https://fixture.invalid/' }),
    CHOICE_CREDENTIALS: JSON.stringify({ mode: 'password', account, password: 'fixture-password', deviceId: 'fixture-device', deviceModel: 'MACMD5' }),
  } as Cloudflare.Env;
  const ctx = { storage } as unknown as DurableObjectState;
  return { session: new ChoiceSession(ctx, env), storage };
}

function request(body = JSON.stringify({ codes: 'TEST.IB', indicators: 'RATE' }), headers?: HeadersInit): Request {
  return new Request('https://choice.session.internal/query/tradedates', { method: 'POST', body, headers });
}

function dataCalls(): number {
  return offline.exchange.mock.calls.filter(([endpoint]) => endpoint.port !== 19).length;
}

beforeEach(() => {
  vi.resetAllMocks();
  now = BASE_TIME;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden in offline native session tests'); }));
  offline.exchange.mockImplementation(async (endpoint: { port: number }) => endpoint.port === 19 ? loginFrame() : frame(250));
  offline.encodeQuery.mockReturnValue({ serverType: 3, frame: new Uint8Array([1]) });
  offline.decodeQuery.mockReturnValue(table);
  offline.statistics.mockResolvedValue({ function: 'DATASTATISTICS', fields: [], rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Choice native offline session lifecycle', () => {
  it('logs in once per token lifetime without opening a heartbeat socket, even across object restarts', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    expect(storage.values.get('session')).toEqual({ uid: 'fixture-uid', token: 'fixture-live-token', at: now });
    now += 19 * 60_000;
    const restarted = createSession(storage).session;
    expect((await restarted.fetch(request())).status).toBe(200);
    expect((await session.fetch(request())).status).toBe(200);
    expect(offline.exchange.mock.calls.filter(([endpoint]) => endpoint.port === 19)).toHaveLength(1);
    expect(offline.exchange.mock.calls.some(([endpoint]) => endpoint.port === 2)).toBe(false);
    expect(dataCalls()).toBe(3);
  });

  it('logs in again after the token lifetime using the rolled activation', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    expect(storage.values.get('activation')).toEqual({ uid: 'fixture-uid', ctoken: 'fixture-rolled-ctoken', utoken: 'fixture-rolled-utoken' });
    now += 20 * 60_000 + 1;
    expect((await createSession(storage).session.fetch(request())).status).toBe(200);
    const secondLogin = offline.exchange.mock.calls.filter(([endpoint]) => endpoint.port === 19)[1];
    const loginBody = new TextDecoder().decode((secondLogin?.[1] as Uint8Array).subarray(14));
    expect(loginBody).toContain('fixture-rolled-ctoken');
    expect(loginBody).toContain('fixture-rolled-utoken');
    expect(loginBody).not.toContain('fixture-password');
  });

  it('keeps the stored token after a failed query so the next query needs no login', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    const stored = storage.values.get('session');
    offline.exchange.mockRejectedValueOnce(new ChoiceTransportError('Synthetic query failure'));
    expect((await session.fetch(request())).status).toBe(503);
    expect(storage.values.get('session')).toBe(stored);
    expect((await createSession(storage).session.fetch(request())).status).toBe(200);
    expect(offline.exchange.mock.calls.filter(([endpoint]) => endpoint.port === 19)).toHaveLength(1);
  });

  it('deletes an expired token, and a failed relogin cools down across object restarts', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    now += 20 * 60_000 + 1;
    offline.exchange.mockResolvedValueOnce(loginFrame('10001020'));
    expect((await session.fetch(request())).status).toBe(503);
    expect(storage.values.has('session')).toBe(false);
    const logins = () => offline.exchange.mock.calls.filter(([endpoint]) => endpoint.port === 19).length;
    expect(logins()).toBe(2);
    now += 30_000;
    expect((await createSession(storage).session.fetch(request())).status).toBe(503);
    expect(logins()).toBe(2);
    now += 31_000;
    expect((await createSession(storage).session.fetch(request())).status).toBe(200);
    expect(logins()).toBe(3);
  });

  it('clears the token, activation and identity on reset', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    await session.reset();
    for (const key of ['session', 'activation', 'identity', 'lastLoginAt']) expect(storage.values.has(key)).toBe(false);
  });

  it('rejects a durable identity mismatch until administrative reset', async () => {
    const { session, storage } = createSession();
    expect((await session.fetch(request())).status).toBe(200);
    const networkBefore = offline.exchange.mock.calls.length;
    const changedIdentity = createSession(storage, 'other-fixture-account').session;
    expect((await changedIdentity.fetch(request())).status).toBe(503);
    expect(offline.exchange).toHaveBeenCalledTimes(networkBefore);

    await changedIdentity.reset();
    expect(storage.values.has('identity')).toBe(false);
    expect(storage.values.has('activation')).toBe(false);
    expect((await changedIdentity.fetch(request())).status).toBe(200);
    expect(dataCalls()).toBe(2);
  });

  it.each(['{', '', '[]', 'null'])('returns 422 for malformed or invalid JSON payload %j without login', async body => {
    const { session } = createSession();
    expect((await session.fetch(request(body))).status).toBe(422);
    expect(offline.exchange).not.toHaveBeenCalled();
  });

  it('returns 413 for a declared oversized body without reading it or logging in', async () => {
    const { session } = createSession();
    expect((await session.fetch(request('{}', { 'Content-Length': '32769' }))).status).toBe(413);
    expect(offline.exchange).not.toHaveBeenCalled();
  });

  it('returns 413 for an oversized body without Content-Length and never logs in', async () => {
    const { session } = createSession();
    expect((await session.fetch(request(' '.repeat(32_769)))).status).toBe(413);
    expect(offline.exchange).not.toHaveBeenCalled();
  });

  it('drops an expired queued request without a second data query', async () => {
    const { session } = createSession();
    const entered = deferred<void>();
    const release = deferred<NativeFrame>();
    offline.exchange.mockImplementation(async (endpoint: { port: number }) => {
      if (endpoint.port === 19) return loginFrame();
      entered.resolve();
      return release.promise;
    });
    const first = session.fetch(request());
    await entered.promise;
    const expired = session.fetch(request());
    now += 56_000;
    release.resolve(frame(250));
    expect((await first).status).toBe(200);
    const response = await expired;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'UPSTREAM_TIMEOUT' } });
    expect(dataCalls()).toBe(1);
  });

  it('preserves a numeric login error without reflecting upstream text or credentials', async () => {
    const { session } = createSession();
    offline.exchange.mockResolvedValueOnce(loginFrame('10001020'));
    const response = await session.fetch(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { upstreamCode: 10001020 } });
    expect(dataCalls()).toBe(0);
  });

});
