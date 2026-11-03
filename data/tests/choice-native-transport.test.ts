import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('cloudflare:sockets', () => ({ connect: sockets.connect }));

import {
  ChoiceConnection, ChoiceTransportError, MAX_FRAME_BYTES, exchange, readBounded,
} from '../src/choice/native/transport.ts';

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.trim().split(/\s+/), byte => Number.parseInt(byte, 16));
}

// Independent receive fixtures: total length is little endian at offsets 1..4.
// Header is 13 bytes; compression is byte 7, type byte 6, status byte 9.
const FIRST = hex('00 10 00 00 00 01 fa 00 00 00 00 00 00 de ad be');
const SECOND = hex('00 0f 00 00 00 01 64 00 00 00 00 00 00 00 ff');

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function socketFixture(chunks: Uint8Array[] = [], end = true) {
  let readable!: ReadableStreamDefaultController<Uint8Array>;
  let finishClosed!: () => void;
  const cancelled = vi.fn();
  const written = vi.fn();
  const socket = {
    opened: Promise.resolve({ remoteAddress: 'fixture.invalid', localAddress: 'fixture.invalid' }),
    closed: new Promise<void>(resolve => { finishClosed = resolve; }),
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        readable = controller;
        for (const chunk of chunks) controller.enqueue(chunk);
        if (end) controller.close();
      },
      cancel: cancelled,
    }),
    writable: new WritableStream<Uint8Array>({ write: written }),
    close: vi.fn(async () => {
      try { readable.error(new Error('Synthetic socket close')); } catch { /* Already closed. */ }
      finishClosed();
    }),
  };
  sockets.connect.mockReturnValue(socket);
  return { socket, cancelled, written };
}

function gzipFrame(decoded: Uint8Array): Uint8Array {
  const body = new Uint8Array(gzipSync(decoded));
  const header = hex('00 00 00 00 00 01 fa 02 00 00 00 00 00');
  new DataView(header.buffer).setUint32(1, 13 + body.length, true);
  return concat(header, body);
}

beforeEach(() => {
  sockets.connect.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden in offline native transport tests'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Choice native offline TCP framing', () => {
  it('reassembles fragmented headers and bodies and retains bytes for the next frame', async () => {
    const joined = concat(FIRST, SECOND);
    const { socket } = socketFixture([
      joined.subarray(0, 2), joined.subarray(2, 9), joined.subarray(9, 15),
      joined.subarray(15, 26), joined.subarray(26),
    ]);
    const connection = new ChoiceConnection({ hostname: 'fixture.invalid', port: 3 });
    try {
      const first = await connection.receive();
      const second = await connection.receive();
      expect(first.header).toEqual(FIRST.subarray(0, 13));
      expect(first.body).toEqual(hex('de ad be'));
      expect(second.header).toEqual(SECOND.subarray(0, 13));
      expect(second.body).toEqual(hex('00 ff'));
    } finally { await connection.close(); }
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('reads two coalesced frames without discarding the second response', async () => {
    socketFixture([concat(FIRST, SECOND)]);
    const connection = new ChoiceConnection({ hostname: 'fixture.invalid', port: 3 });
    try {
      expect((await connection.receive()).body).toEqual(hex('de ad be'));
      expect((await connection.receive()).body).toEqual(hex('00 ff'));
    } finally { await connection.close(); }
  });

  it.each([
    ['header', hex('00 10 00')],
    ['body', hex('00 10 00 00 00 01 fa 00 00 00 00 00 00 de')],
  ])('rejects EOF in the middle of the %s and closes the socket', async (_part, bytes) => {
    const { socket } = socketFixture([bytes]);
    await expect(exchange({ hostname: 'fixture.invalid', port: 3 }, hex('01'), 1_000)).rejects.toThrow('Truncated Choice frame');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['larger than 16 MiB', hex('00 01 00 00 01 01 fa 00 00 00 00 00 00')],
    ['smaller than the header', hex('00 0c 00 00 00 01 fa 00 00 00 00 00 00')],
  ])('rejects advertised length %s before waiting for a body', async (_description, bytes) => {
    const { socket } = socketFixture([bytes], false);
    await expect(exchange({ hostname: 'fixture.invalid', port: 3 }, hex('01'), 1_000)).rejects.toThrow('Invalid Choice receive length');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('decompresses a valid gzip response', async () => {
    const decoded = hex('01 02 03 04 05');
    const { socket } = socketFixture([gzipFrame(decoded)]);
    const result = await exchange({ hostname: 'fixture.invalid', port: 3 }, hex('01'), 1_000);
    expect(result.body).toEqual(decoded);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('bounds expanded gzip output even when the compressed frame is small', async () => {
    const packed = gzipFrame(new Uint8Array(MAX_FRAME_BYTES + 1).fill(65));
    expect(packed.length).toBeLessThan(32_768);
    const { socket } = socketFixture([packed]);
    await expect(exchange({ hostname: 'fixture.invalid', port: 3 }, hex('01'), 1_000)).rejects.toThrow('Choice decoded payload exceeds limit');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('cancels a stalled input stream when its abort signal fires', async () => {
    let didPull!: () => void;
    const pulled = new Promise<void>(resolve => { didPull = resolve; });
    const cancelled = vi.fn();
    const input = new ReadableStream<Uint8Array>({ pull() { didPull(); }, cancel: cancelled });
    const controller = new AbortController();
    const result = readBounded(input, 32_768, controller.signal).catch(error => error);
    await pulled;
    controller.abort();
    const error: unknown = await result;
    expect(error).toBeInstanceOf(ChoiceTransportError);
    expect(error).toMatchObject({ timeout: true });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(input.locked).toBe(false);
    expect(sockets.connect).not.toHaveBeenCalled();
  });

  it('closes a socket with a pending read when the shared exchange deadline expires', async () => {
    const { socket, written } = socketFixture([], false);
    const request = hex('01 02');
    const error: unknown = await exchange({ hostname: 'fixture.invalid', port: 3 }, request, 10).catch(cause => cause);
    expect(error).toBeInstanceOf(ChoiceTransportError);
    expect(error).toMatchObject({ timeout: true });
    expect(written).toHaveBeenCalledWith(request, expect.anything());
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
