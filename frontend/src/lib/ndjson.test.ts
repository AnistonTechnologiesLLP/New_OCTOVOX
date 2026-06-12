/* Unit tests for the NDJSON streaming clean port (legacy contract:
   app.js:1541-1598). Verifies the parsing, the progress callbacks, and the
   full fallback matrix. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanStreaming, stripProdPrefix } from './ndjson';
import type { ProdOpts } from './types';

const OPTS = { nr: 'dfn' } as unknown as ProdOpts;

const DONE = {
  type: 'done',
  ok: true,
  stem: 's1',
  clean: '/output/s1/clean_prod.wav',
  input: '/output/s1/input_mono.wav',
  report: null,
  stages: {},
  timings: {},
  sr: 48000,
  n_channels: 8,
  elapsed_s: 1.2,
};

function streamResponse(lines: string[], { status = 200 }: { status?: number } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      lines.forEach((l) => c.enqueue(enc.encode(l)));
      c.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, body } as unknown as Response;
}

function jsonResponse(payload: unknown, { status = 200 }: { status?: number } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: () => Promise.resolve(payload),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripProdPrefix', () => {
  it('strips the prod: prefix case-insensitively', () => {
    expect(stripProdPrefix('prod: loaded 8ch')).toBe('loaded 8ch');
    expect(stripProdPrefix('PROD:   beamform')).toBe('beamform');
    expect(stripProdPrefix('no prefix')).toBe('no prefix');
    expect(stripProdPrefix(null)).toBe('');
  });
});

describe('cleanStreaming', () => {
  it('parses NDJSON progress + done, splitting on newlines across chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        '{"type":"progress","message":"prod: loaded","pct":5,"stage":"calibrate"}\n',
        '{"type":"progress","message":"prod: beamform"',
        ',"pct":64,"stage":"beamform"}\n',
        `${JSON.stringify(DONE)}\n`,
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const progress: Array<[string, number, string | undefined]> = [];
    const j = await cleanStreaming('a.wav', OPTS, (m, p, s) => progress.push([m, p, s]));

    expect(j.stem).toBe('s1');
    expect(progress).toEqual([
      ['loaded', 5, 'calibrate'],
      ['beamform', 64, 'beamform'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/clean_stream');
  });

  it('skips malformed lines without failing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse(['not json\n', `${JSON.stringify(DONE)}\n`]),
      ),
    );
    const j = await cleanStreaming('a.wav', OPTS, () => undefined);
    expect(j.ok).toBe(true);
  });

  it('falls back to sync /api/clean on transport failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse({ ...DONE, type: undefined }));
    vi.stubGlobal('fetch', fetchMock);

    const j = await cleanStreaming('a.wav', OPTS, () => undefined);
    expect(j.stem).toBe('s1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/clean');
  });

  it('falls back to sync /api/clean on HTTP 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ ...DONE, type: undefined }));
    vi.stubGlobal('fetch', fetchMock);

    const j = await cleanStreaming('a.wav', OPTS, () => undefined);
    expect(j.stem).toBe('s1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/clean');
  });

  it('throws (no fallback) on other non-OK statuses, using the json error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'bad knob' }, { status: 500 })),
    );
    await expect(cleanStreaming('a.wav', OPTS, () => undefined)).rejects.toThrow('bad knob');
  });

  it('falls back to sync when the stream closes with zero events', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([]))
      .mockResolvedValueOnce(jsonResponse({ ...DONE, type: undefined }));
    vi.stubGlobal('fetch', fetchMock);

    const j = await cleanStreaming('a.wav', OPTS, () => undefined);
    expect(j.stem).toBe('s1');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/clean');
  });

  it('throws when the stream had events but no done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        streamResponse(['{"type":"progress","message":"x","pct":10}\n']),
      ),
    );
    await expect(cleanStreaming('a.wav', OPTS, () => undefined)).rejects.toThrow(
      'clean stream ended without a result',
    );
  });

  it('throws on an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        streamResponse(['{"type":"error","message":"stage blew up"}\n']),
      ),
    );
    await expect(cleanStreaming('a.wav', OPTS, () => undefined)).rejects.toThrow('stage blew up');
  });

  it('propagates sync-fallback errors (clean ok:false)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'no such file' }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(cleanStreaming('a.wav', OPTS, () => undefined)).rejects.toThrow('no such file');
  });
});
