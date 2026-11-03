import { ApiError, errorResponse } from '../../http';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { ChoiceLoginError, encodeAutoLogin, encodePasswordLogin, decodeLoginResponse } from './auth';
import { parseNativeConfig, type ChoiceCredentials } from './config';
import { ChoiceTransportError, exchange } from './transport';
import { fetchNativeStatistics } from './statistics';
import { ChoiceQuotaError, executeAccountedEdb } from './quota';
import { readUpstreamJson } from '../../upstream-diagnostics';
import { requireUpstreamCapacity } from '../../upstream-rate-limit';
import { decodeChoiceSheets, assertQueryFrame, ChoiceServerError } from './wire';
import { percentMetadataRequest, decodePercentMetadata, percentFlags, codeTypeRequest, decodeCodeTypes, type PercentMetadata } from './percent';
import { encodeQuery, decodeQuery, calendarQueryForCsd, publishDateQueryForEdb } from './query';
import { choiceTableSchema, type ChoiceTable } from '../client';

const querySchema = z.object({ function: z.enum(['csd','css','edb','ctr','tradedates','datastatistics']), payload: z.record(z.string(), z.unknown()) });
interface StoredActivation { uid: string; ctoken: string; utoken: string }
interface LiveSession { uid: string; token: string; at: number }

// Live probe 2026-11-03: a login token stayed valid for 30+ minutes with no heartbeat registered,
// and the heartbeat server drops idle sockets within 58 s. Hold no socket; refresh well inside the tested span.
const SESSION_TTL_MS = 20 * 60_000;

/** One actor per licensed account. Each query is a short-lived exchange; the login token is stored, not kept alive. */
export class ChoiceSession extends DurableObject<Cloudflare.Env> {
  private active?: LiveSession;
  private pending: Promise<unknown> = Promise.resolve();
  private cooldown = 0;
  private percentCache?: { value: PercentMetadata; expires: number };
  private readonly securityTypes = new Map<string, { type: number; expires: number }>();
  private readonly config: ReturnType<typeof parseNativeConfig>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.config = parseNativeConfig(env.CHOICE_SERVERS, env.CHOICE_CREDENTIALS);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || !/^\/query\/(csd|css|edb|ctr|tradedates|datastatistics)$/.test(new URL(request.url).pathname)) return new Response(null, { status: 404 });
    const started = Date.now();
    const operation = this.pending.then(async () => {
      if (Date.now() - started > 55_000 || request.signal.aborted) throw new ChoiceTransportError('Choice queue deadline exceeded', true);
      // Bindings are private, but enforce a small body before parsing any input.
      const length = Number(request.headers.get('Content-Length'));
      if (length > 32768) return new Response(null, { status: 413 });
      const { readBounded } = await import('./transport');
      let inputPayload: unknown;
      try {
        const bytes = request.body ? await readBounded(request.body, 32768, AbortSignal.timeout(remaining(started + 60_000))) : new Uint8Array();
        inputPayload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        if (error instanceof ChoiceTransportError && error.timeout) throw error;
        return new Response(null, { status: error instanceof ChoiceTransportError ? 413 : 422 });
      }
      const parsed = querySchema.safeParse({ function: new URL(request.url).pathname.split('/').at(-1), payload: inputPayload });
      if (!parsed.success) return new Response(null, { status: 422 });
      await this.ensureSession(started + 60_000);
      if (Date.now() - started > 55_000 || request.signal.aborted) throw new ChoiceTransportError('Choice queue deadline exceeded', true);
      const { function: name, payload } = parsed.data;
      const session = this.active!;
      let table: ChoiceTable;
      if (name === 'datastatistics') table = await fetchNativeStatistics(this.config.servers.statisticsOrigin, session.token, payload, remaining(started + 60_000));
      else {
        const percentByCode = name === 'csd' || name === 'css' ? await this.percentageIndicators(name, payload, started + 60_000) : undefined;
        let expectedDates: string[] | undefined;
        if (name === 'csd') {
          const calendarPayload = calendarQueryForCsd(payload);
          const calendar = encodeQuery('tradedates', calendarPayload, session.token, session.uid);
          await requireUpstreamCapacity(this.env.CHOICE_OTHER_LIMIT, 'tradedates', 'Choice');
          const result = await exchange(this.config.servers['3'], calendar.frame, remaining(started + 60_000));
          assertQueryFrame(result);
          expectedDates = decodeQuery('tradedates', calendarPayload, result.body).rows.map(row => String(row.date));
        }
        const query = encodeQuery(name, payload, session.token, session.uid);
        const queryData = async () => {
        let published: Uint8Array | undefined;
        const publicationQuery = name === 'edb' ? publishDateQueryForEdb(payload, session.uid) : undefined;
        if (publicationQuery) {
          await requireUpstreamCapacity(this.env.CHOICE_OTHER_LIMIT, 'edb', 'Choice');
          const publication = await exchange(this.config.servers['6'], publicationQuery.frame, remaining(started + 60_000));
          assertQueryFrame(publication);
          published = publication.body;
        }
        const result = await exchange(this.config.servers[String(query.serverType) as '3'|'6'|'20'], query.frame, remaining(started + 60_000));
        // SDK reports server-side string/error responses using status byte9 101/102/103/107.
        assertQueryFrame(result);
        return { value: decodeQuery(name, payload, result.body, expectedDates, percentByCode, published), sheets: name === 'edb' ? decodeChoiceSheets(result.body) : [] };
        };
        table = name === 'edb' ? await executeAccountedEdb(session.token, async request => {
          await requireUpstreamCapacity(this.env.CHOICE_OTHER_LIMIT, 'edb', 'Choice');
          const response = await fetch(new URL(request.path, this.config.servers.statisticsOrigin), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: request.body, signal: AbortSignal.timeout(remaining(started + 60_000)) });
          if (!response.ok) { await response.body?.cancel(); throw new Error('Choice quota HTTP error'); }
          return readUpstreamJson(response, [session.token]);
        }, queryData) : (await queryData()).value;
      }
      if (this.active !== session) throw new Error('Choice session changed during query');
      return Response.json(choiceTableSchema.parse(table), { headers: { 'Cache-Control': 'no-store', 'X-Choice-Native-Version': 'choice.native.v1' } });
    });
    this.pending = operation.catch(() => undefined);
    try { return await operation; }
    catch (error) {
      // Deliberately omit vendor response/error text, tokens, endpoint and activation data.
      if (error instanceof ApiError && error.status === 429) return errorResponse(error);
      const timeout = error instanceof ChoiceTransportError && error.timeout || error instanceof DOMException && error.name === 'TimeoutError';
      return Response.json({ error: { code: timeout ? 'UPSTREAM_TIMEOUT' : 'CHOICE_NATIVE_ERROR', message: timeout ? 'Choice native request timed out' : 'Choice native request failed', ...(error instanceof ChoiceLoginError || error instanceof ChoiceQuotaError || error instanceof ChoiceServerError || error instanceof ChoiceTransportError && error.upstreamCode !== undefined ? { upstreamCode: error.upstreamCode } : {}) } }, { status: timeout ? 504 : 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  private async percentageIndicators(name: 'csd'|'css', payload: Record<string, unknown>, deadline: number): Promise<Record<string, string[]>> {
    const codes = [...new Set(String(payload.codes ?? '').toUpperCase().split(',').map(code => code.trim()).filter(Boolean))];
    const indicators = String(payload.indicators ?? '').toUpperCase().split(',').map(field => field.trim()).filter(Boolean);
    if (!codes.length || !indicators.length) throw new Error('Choice codes and indicators are required');
    const metadataExchange = async (frame: Uint8Array) => {
      await requireUpstreamCapacity(this.env.CHOICE_OTHER_LIMIT, 'ctr', 'Choice');
      const reply = await exchange(this.config.servers['3'], frame, remaining(deadline));
      assertQueryFrame(reply);
      return reply.body;
    };
    if (!this.percentCache || this.percentCache.expires <= Date.now()) {
      const value = decodePercentMetadata(await metadataExchange(percentMetadataRequest().frame));
      this.percentCache = { value, expires: Date.now() + 3600_000 };
    }
    const missing = codes.filter(code => !this.securityTypes.has(code) || this.securityTypes.get(code)!.expires <= Date.now());
    if (missing.length) {
      const types = decodeCodeTypes(await metadataExchange(codeTypeRequest(missing).frame));
      for (const code of missing) {
        const type = types.get(code);
        if (type === undefined) throw new Error('Choice security type missing');
        this.securityTypes.set(code, { type, expires: Date.now() + 3600_000 });
      }
      if (this.securityTypes.size > 4096) for (const key of this.securityTypes.keys()) if (!codes.includes(key)) this.securityTypes.delete(key);
    }
    return Object.fromEntries(codes.map(code => {
      const flags = percentFlags(this.percentCache!.value, name === 'csd' ? 'CSD' : 'CSS', indicators, this.securityTypes.get(code)!.type);
      return [code, indicators.filter((_, index) => flags[index])];
    }));
  }

  private async ensureSession(deadline: number): Promise<void> {
    const identity = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([this.config.credentials.mode === 'auto' ? this.config.credentials.uid : this.config.credentials.account, this.config.credentials.deviceId, this.config.credentials.deviceModel])));
    const fingerprint = Array.from(new Uint8Array(identity), b => b.toString(16).padStart(2, '0')).join('');
    const previous = await this.ctx.storage.get<string>('identity');
    if (previous && previous !== fingerprint) throw new Error('Choice credential identity changed; operator reset required');
    if (!previous) await this.ctx.storage.put('identity', fingerprint);
    if (await this.currentSession()) return;
    if (Date.now() < this.cooldown) throw new Error('Choice login is cooling down');
    // Store before attempting I/O so object eviction cannot cause a tight relogin loop.
    const last = await this.ctx.storage.get<number>('lastLoginAt') ?? 0;
    if (Date.now() - last < 60_000) throw new Error('Choice login is cooling down');
    await this.ctx.storage.put('lastLoginAt', Date.now());
    const credentials = this.config.credentials;
    const saved = await this.ctx.storage.get<StoredActivation>('activation');
    const auto = saved ? { ...credentials, ...saved } : credentials;
    const request = 'uid' in auto ? encodeAutoLogin(auto) : encodePasswordLogin(auto.account, auto.password, auto);
    try {
      const reply = await exchange(this.config.servers['19'], request, remaining(deadline));
      const login = decodeLoginResponse(reply.body);
      // Persist the rolled activation and the token before publishing the login as usable.
      await this.ctx.storage.put('activation', { uid: login.uid, ctoken: login.ctoken, utoken: login.utoken } satisfies StoredActivation);
      const live: LiveSession = { uid: login.uid, token: login.token, at: Date.now() };
      await this.ctx.storage.put('session', live);
      this.active = live;
    } catch (error) { await this.invalidate(); throw error; }
  }

  private async currentSession(): Promise<LiveSession | undefined> {
    const saved = this.active ?? await this.ctx.storage.get<LiveSession>('session');
    if (saved && Date.now() - saved.at < SESSION_TTL_MS) return this.active = saved;
    this.active = undefined;
    if (saved) await this.ctx.storage.delete('session');
    return undefined;
  }

  /** Administrative binding RPC only; no public HTTP route exposes recovery. */
  async reset(): Promise<void> {
    const operation = this.pending.then(async () => {
      await this.invalidate();
      for (const key of ['identity', 'activation', 'lastLoginAt']) await this.ctx.storage.delete(key);
      this.cooldown = 0; this.percentCache = undefined; this.securityTypes.clear();
    });
    this.pending = operation.catch(() => undefined);
    await operation;
  }

  private async invalidate(): Promise<void> {
    this.active = undefined;
    this.cooldown = Date.now() + 60_000;
    await this.ctx.storage.delete('session');
  }
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms < 1_000) throw new ChoiceTransportError('Choice request deadline exceeded', true);
  return ms;
}
