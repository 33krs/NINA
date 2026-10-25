import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Request, Response } from 'express';
import { Buffer, constants } from 'node:buffer';
import {
  IncomingMessage,
  ServerResponse,
  request as httpRequest,
  type ClientRequest,
  type OutgoingHttpHeaders,
} from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import {
  createBrowserAuthJson,
  type BrowserAuthJsonLimits,
} from './browser-auth-json.middleware';
import { browserAuthNoStore } from './browser-auth-no-store.middleware';

const MAX_BYTES = 64;
const READ_MS = 100;
const seen: unknown[] = [];
const limits = { maxBytes: MAX_BYTES, readTimeoutMs: READ_MS };

@Controller('synthetic-json')
class SyntheticJsonController {
  @Post()
  @HttpCode(202)
  accept(@Req() request: Request) {
    const body: unknown = request.body;
    seen.push(body);
    return { accepted: true };
  }
}

interface HttpResult {
  readonly status: number | undefined;
  readonly cache: string | string[] | undefined;
  readonly connection: string | undefined;
  readonly body: string;
}

function direct(limitsOverride = limits) {
  const request = new IncomingMessage(new Socket()) as Request;
  const response = new ServerResponse(request) as Response;
  const next = jest.fn();
  const invoke = () =>
    createBrowserAuthJson(limitsOverride)(request, response, next);
  return { request, response, next, invoke };
}

describe('bounded JSON lifecycle', () => {
  afterEach(() => jest.useRealTimers());

  it.each([0, -1, 1.5, NaN, Infinity, constants.MAX_LENGTH + 1])(
    'rejects invalid maxBytes %s without defaults',
    (maxBytes) =>
      expect(() => createBrowserAuthJson({ ...limits, maxBytes })).toThrow(),
  );
  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])(
    'rejects invalid readTimeoutMs %s',
    (readTimeoutMs) =>
      expect(() =>
        createBrowserAuthJson({ ...limits, readTimeoutMs }),
      ).toThrow(),
  );
  it('rejects missing and throwing configuration without leaking its exception', () => {
    for (const config of [
      null,
      {},
      {
        get maxBytes() {
          throw new Error('Synthetic detail');
        },
      },
    ]) {
      expect(() =>
        createBrowserAuthJson(config as BrowserAuthJsonLimits),
      ).toThrow('Invalid browser JSON limits');
    }
  });
  it('copies configuration and continues once with exact parsed values', () => {
    jest.useFakeTimers();
    const mutable = { maxBytes: 4, readTimeoutMs: READ_MS };
    const read = createBrowserAuthJson(mutable);
    mutable.maxBytes = 1;
    mutable.readTimeoutMs = 1;
    const fixture = direct();
    read(fixture.request, fixture.response, fixture.next);
    fixture.request.emit('data', Buffer.from('null'));
    fixture.request.emit('end');
    fixture.request.emit('end');
    jest.runAllTimers();
    expect(fixture.request.body).toBeNull();
    expect(fixture.next).toHaveBeenCalledTimes(1);
    expect(fixture.request.listenerCount('data')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    fixture.request.destroy();
  });
  it('cleans duplicate rejection without publishing a body or late continuation', () => {
    jest.useFakeTimers();
    const fixture = direct();
    const foreignListener = jest.fn();
    fixture.request.on('aborted', foreignListener);
    fixture.invoke();
    fixture.request.emit('data', Buffer.from('{"x":1,"x":2}'));
    fixture.request.emit('end');
    fixture.request.emit('data', Buffer.from('{}'));
    fixture.request.emit('end');
    jest.runAllTimers();
    expect(fixture.response.statusCode).toBe(400);
    expect(Object.hasOwn(fixture.request, 'body')).toBe(false);
    expect(fixture.next).not.toHaveBeenCalled();
    expect(fixture.request.listeners('aborted')).toEqual([foreignListener]);
    for (const event of ['data', 'end', 'error', 'close'])
      expect(fixture.request.listenerCount(event)).toBe(0);
    expect(fixture.response.listenerCount('finish')).toBe(0);
    expect(fixture.response.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    fixture.request.destroy();
  });
  it('preserves deeply nested objects and arrays without recursive scanning', () => {
    const depth = 10000;
    const text = '{"x":['.repeat(depth) + '0' + ']}'.repeat(depth);
    const fixture = direct({
      maxBytes: Buffer.byteLength(text),
      readTimeoutMs: READ_MS,
    });
    fixture.invoke();
    fixture.request.emit('data', Buffer.from(text));
    fixture.request.emit('end');
    expect(fixture.next).toHaveBeenCalledTimes(1);
    let value: unknown = fixture.request.body;
    for (let index = 0; index < depth; index++) {
      expect(value).not.toBeNull();
      expect(typeof value).toBe('object');
      const array: unknown = (value as Record<string, unknown>).x;
      expect(Array.isArray(array)).toBe(true);
      value = (array as unknown[])[0];
    }
    expect(value).toBe(0);
    fixture.request.destroy();
  });
  it.each(['body', 'encoded', 'consumed', 'paused', 'destroyed'])(
    'rejects %s input without a second reader',
    (mode) => {
      const fixture = direct();
      if (mode === 'body')
        Object.defineProperty(fixture.request, 'body', { value: undefined });
      if (mode === 'encoded') fixture.request.setEncoding('utf8');
      if (mode === 'consumed') {
        fixture.request.push(Buffer.from('{}'));
        fixture.request.read(1);
      }
      if (mode === 'paused') fixture.request.pause();
      if (mode === 'destroyed') fixture.request.destroy();
      fixture.invoke();
      expect(fixture.next).not.toHaveBeenCalled();
      expect(fixture.response.statusCode).toBe(400);
      expect(fixture.request.listenerCount('data')).toBe(0);
      fixture.request.destroy();
    },
  );
  it.each([
    'aborted',
    'error',
    'close',
    'response-finish',
    'response-close',
    'deadline',
  ])(
    'cleans its listeners/timer and denies late continuation after %s',
    (event) => {
      jest.useFakeTimers();
      const fixture = direct();
      const foreignListener = jest.fn();
      fixture.request.on('aborted', foreignListener);
      fixture.invoke();
      fixture.request.emit('data', Buffer.from('{'));
      if (event === 'deadline') jest.advanceTimersByTime(READ_MS);
      else if (event.startsWith('response-'))
        fixture.response.emit(event.slice(9));
      else if (event === 'error')
        fixture.request.emit('error', new Error('Synthetic stream failure'));
      else fixture.request.emit(event);
      fixture.request.emit('data', Buffer.from('}'));
      fixture.request.emit('end');
      jest.runAllTimers();
      expect(fixture.next).not.toHaveBeenCalled();
      expect(Object.hasOwn(fixture.request, 'body')).toBe(false);
      expect(fixture.request.listeners('aborted')).toEqual([foreignListener]);
      for (const name of ['data', 'end', 'error', 'close']) {
        expect(fixture.request.listenerCount(name)).toBe(0);
      }
      expect(fixture.response.listenerCount('finish')).toBe(0);
      expect(fixture.response.listenerCount('close')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      if (event === 'deadline') expect(fixture.response.statusCode).toBe(408);
      fixture.request.destroy();
    },
  );
  it('rejects string chunks rather than counting decoded characters', () => {
    const fixture = direct();
    fixture.invoke();
    fixture.request.emit('data', '{}');
    fixture.request.emit('end');
    expect(fixture.response.statusCode).toBe(400);
    expect(fixture.next).not.toHaveBeenCalled();
    fixture.request.destroy();
  });
  it('rejects ended input and ignores responses that are already finished', async () => {
    const ended = direct();
    const finished = new Promise<void>((resolve) =>
      ended.request.once('end', resolve),
    );
    ended.request.push(null);
    ended.request.resume();
    await finished;
    ended.invoke();
    expect(ended.next).not.toHaveBeenCalled();
    expect(ended.response.statusCode).toBe(400);
    const fixture = direct();
    fixture.response.end('Synthetic response');
    fixture.invoke();
    expect(fixture.next).not.toHaveBeenCalled();
    expect(fixture.request.listenerCount('data')).toBe(0);
    ended.request.destroy();
    fixture.request.destroy();
  });
  it('does not concatenate or parse the crossing chunk or a late end event', () => {
    const fixture = direct();
    const concat = jest.spyOn(Buffer, 'concat');
    const parse = jest.spyOn(JSON, 'parse');
    try {
      fixture.invoke();
      fixture.request.emit('data', Buffer.alloc(MAX_BYTES + 1));
      fixture.request.emit('end');
      expect(concat).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(fixture.response.statusCode).toBe(413);
      expect(fixture.next).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
      parse.mockRestore();
      fixture.request.destroy();
    }
  });
});

describe('strict bounded JSON over isolated HTTP', () => {
  let app: NestExpressApplication;
  let port: number;
  let firstChunk: (() => void) | undefined;
  let serverRequest: Request;
  const clients = new Set<ClientRequest>();

  function open(headers: OutgoingHttpHeaders = {}) {
    let client: ClientRequest;
    const result = new Promise<HttpResult>((resolve, reject) => {
      client = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/synthetic-json',
          method: 'POST',
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () =>
            resolve({
              status: response.statusCode,
              cache: response.headers['cache-control'],
              connection: response.headers.connection,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      clients.add(client);
      client.once('error', reject);
      client.setTimeout(1500, () =>
        client.destroy(new Error('Synthetic client timeout')),
      );
    });
    return { client: client!, result };
  }
  async function send(
    body: string | Buffer,
    headers: OutgoingHttpHeaders = {},
  ) {
    const exchange = open(headers);
    exchange.client.end(body);
    return exchange.result;
  }
  function assertRejected(result: HttpResult, status: number) {
    expect(result).toEqual({
      status,
      cache: 'no-store',
      connection: 'close',
      body: JSON.stringify({ message: 'Invalid request body' }),
    });
    expect(seen).toEqual([]);
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SyntheticJsonController],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    app.use(browserAuthNoStore);
    const read = createBrowserAuthJson(limits);
    app.use((request: Request, response: Response, next: () => void) => {
      serverRequest = request;
      read(request, response, next);
      if (firstChunk) request.once('data', firstChunk);
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  beforeEach(() => {
    seen.length = 0;
    firstChunk = undefined;
  });
  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.clear();
  });
  afterAll(async () => app?.close());

  it.each(['{}', 'null', 'false', '0', '"synthetic"', '[1,{"x":true}]'])(
    'preserves valid JSON %s without authentication or response echo',
    async (body) => {
      const result = await send(body);
      expect(result.status).toBe(202);
      expect(result.cache).toBe('no-store');
      expect(result.body).toBe('{"accepted":true}');
      expect(seen).toEqual([JSON.parse(body)]);
    },
  );
  it.each([
    '{"x":1,"x":2}',
    '{"x":1,"x":1}',
    '{"":1,"":2}',
    String.raw`{"x":1,"\u0078":2}`,
    String.raw`{"\u0078":1,"\u0078":2}`,
    '{"a":{"x":1,"x":2}}',
    '[0,{"a":[{"x":1,"x":2}]}]',
    String.raw`{"\"":1,"\u0022":2}`,
    String.raw`{"\\":1,"\u005c":2}`,
    String.raw`{"\n":1,"\u000a":2}`,
    String.raw`{"/":1,"\/":2}`,
    String.raw`{"😀":1,"\ud83d\ude00":2}`,
    String.raw`{"\ud800":1,"\uD800":2}`,
    String.raw`{"\udc00":1,"\uDC00":2}`,
    '{"__proto__":1,"__proto__":2}',
    '{"constructor":1,"constructor":2}',
    '{"x" \r\n\t:1,"x":2}',
  ])(
    'rejects duplicate decoded keys without exposing input %#',
    async (body) => {
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BYTES);
      const result = await send(body);
      expect({ status: result.status, calls: seen.length }).toEqual({
        status: 400,
        calls: 0,
      });
      assertRejected(result, 400);
      expect(Object.hasOwn(serverRequest, 'body')).toBe(false);
    },
  );
  it.each([
    '{"x":{"x":1},"a":{"x":2}}',
    '[{"x":1},{"x":2},["x","x"]]',
    '{"__proto__":1,"constructor":2,"toString":3}',
    '{"X":1,"x":2}',
    String.raw`{"é":1,"e\u0301":2}`,
    String.raw`{"\ud800":1,"\udc00":2}`,
    String.raw`{"x":"{\"x\":1,\"x\":2}","a":"\\\"}[:"}`,
    String.raw`["{", "}", "x", "x", "\\", "\"", ":"]`,
    '{"\\u0078" \r: "x"}',
    '[]',
    '-0',
    '1e400',
  ])('preserves distinct keys and string syntax %#', async (body) => {
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BYTES);
    const result = await send(body);
    expect(result.status).toBe(202);
    expect(result.cache).toBe('no-store');
    expect(seen).toEqual([JSON.parse(body)]);
  });
  it.each([true, false])(
    'handles a decoded key escape split across actual HTTP chunks (duplicate=%s)',
    async (duplicate) => {
      const observed = new Promise<void>((resolve) => {
        firstChunk = resolve;
      });
      const exchange = open({ 'Transfer-Encoding': 'chunked' });
      exchange.client.write('{"x":1,"\\u00');
      await observed;
      exchange.client.end(duplicate ? '78":2}' : '79":2}');
      const result = await exchange.result;
      if (duplicate) assertRejected(result, 400);
      else {
        expect(result.status).toBe(202);
        expect(seen).toEqual([{ x: 1, y: 2 }]);
      }
    },
  );
  it.each(['identity', 'IdEnTiTy'])(
    'accepts one case-insensitive identity encoding %s',
    async (encoding) =>
      expect((await send('{}', { 'CoNtEnT-EnCoDiNg': encoding })).status).toBe(
        202,
      ),
  );
  it.each([
    'gzip',
    'deflate',
    'br',
    'unknown',
    'identity, identity',
    ['identity', 'identity'],
  ])('rejects unsupported or duplicate encoding %s', async (encoding) =>
    assertRejected(await send('{}', { 'Content-Encoding': encoding }), 415),
  );
  it.each([
    '',
    '{',
    '{} trailing',
    'undefined',
    '\ufeff{}',
    '"unescaped\nline"',
  ])('rejects malformed JSON %s', async (body) => {
    assertRejected(await send(body), 400);
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from([0x22, 0xc3, 0x22]),
    Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
  ])('rejects malformed UTF-8 buffer %#', async (body) =>
    assertRejected(await send(body), 400),
  );
  it('accepts exactly the byte ceiling but rejects its next byte', async () => {
    expect((await send('"' + 'x'.repeat(MAX_BYTES - 2) + '"')).status).toBe(
      202,
    );
    seen.length = 0;
    assertRejected(await send('"' + 'x'.repeat(MAX_BYTES - 1) + '"'), 413);
  });
  it('preserves a UTF-8 scalar split across actual arriving chunks', async () => {
    const observed = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    exchange.client.write(Buffer.from([0x22, 0xf0, 0x9f]));
    await observed;
    exchange.client.end(Buffer.from([0x98, 0x80, 0x22]));
    expect((await exchange.result).status).toBe(202);
    expect(seen).toEqual(['😀']);
  });
  it('counts multibyte input in bytes, not characters', async () => {
    assertRejected(await send('"' + '😀'.repeat(16) + '"'), 413);
  });
  it.each(['declared', 'chunked'])(
    'rejects %s oversize before the client ends its body',
    async (mode) => {
      const exchange = open(
        mode === 'declared'
          ? { 'Content-Length': MAX_BYTES + 1 }
          : { 'Transfer-Encoding': 'chunked' },
      );
      exchange.client.flushHeaders();
      if (mode === 'chunked')
        exchange.client.write('"' + 'x'.repeat(MAX_BYTES));
      assertRejected(await exchange.result, 413);
      expect(exchange.client.writableEnded).toBe(false);
    },
  );
  it('bounds an unfinished body by a request-local deadline', async () => {
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    exchange.client.write('{');
    assertRejected(await exchange.result, 408);
    expect(exchange.client.writableEnded).toBe(false);
  });
  it('does not continue after a real client abort', async () => {
    const observed = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    const failed = expect(exchange.result).rejects.toThrow();
    exchange.client.write('{');
    await observed;
    const closed = new Promise<void>((resolve) =>
      serverRequest.once('close', resolve),
    );
    exchange.client.destroy(new Error('Synthetic abort'));
    await failed;
    await closed;
    expect(seen).toEqual([]);
    expect(serverRequest.listenerCount('data')).toBe(0);
  });
  it('keeps each concurrent request independently within the byte ceiling', async () => {
    const first = 'x'.repeat(MAX_BYTES - 2);
    const second = 'y'.repeat(MAX_BYTES - 2);
    const results = await Promise.all([
      send(JSON.stringify(first)),
      send(JSON.stringify(second)),
    ]);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(seen).toContainEqual(first);
    expect(seen).toContainEqual(second);
  });
});
