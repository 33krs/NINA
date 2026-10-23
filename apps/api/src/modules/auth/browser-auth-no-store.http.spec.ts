import {
  BadRequestException,
  Controller,
  Header,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { browserAuthNoStore } from './browser-auth-no-store.middleware';

const { fetch } = globalThis;
const calls = { body: 0, guarded: 0 };

class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

@Controller('synthetic-auth')
class SyntheticAuthController {
  @Post('success')
  @HttpCode(202)
  @Header('X-Synthetic', 'unchanged')
  success() {
    return { state: 'synthetic' };
  }

  @Post('guard-denied')
  @UseGuards(DenyGuard)
  guarded() {
    calls.guarded += 1;
    return { unreachable: true };
  }

  @Post('bad-request')
  reject() {
    throw new BadRequestException('Synthetic rejection');
  }

  @Post('unexpected')
  fail() {
    throw new Error('Synthetic internal failure');
  }

  @Post('body')
  body() {
    calls.body += 1;
    return { accepted: true };
  }
}

describe('browserAuthNoStore behavior', () => {
  it('replaces cache policy before one continuation without reading the request', () => {
    const payload = { synthetic: true };
    const headers = new Map([
      ['cache-control', 'public, max-age=3600'],
      ['x-synthetic', 'unchanged'],
    ]);
    const response = {
      statusCode: 207,
      payload,
      setHeader: jest.fn((name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      }),
    };
    const hostileRequest = new Proxy(
      {},
      {
        get() {
          throw new Error('Request properties must not be read');
        },
      },
    ) as Request;
    const next = jest.fn(() => {
      expect(headers.get('cache-control')).toBe('no-store');
      expect(response.statusCode).toBe(207);
      expect(response.payload).toBe(payload);
    });

    browserAuthNoStore(hostileRequest, response as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect([...headers]).toEqual([
      ['cache-control', 'no-store'],
      ['x-synthetic', 'unchanged'],
    ]);
  });

  it('does not suppress a header-write failure or continue after it', () => {
    const failure = new Error('Synthetic header failure');
    const response = {
      setHeader() {
        throw failure;
      },
    } as unknown as Response;
    const next = jest.fn(() => undefined);

    expect(() => browserAuthNoStore({} as Request, response, next)).toThrow(
      failure,
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('early no-store over an isolated HTTP pipeline', () => {
  let app: NestExpressApplication;
  let url: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SyntheticAuthController],
      providers: [DenyGuard],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    app.use(browserAuthNoStore);
    // Test-only limit: production body handling and route activation are deferred.
    app.useBodyParser('json', { limit: 64 });
    await app.init();
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    calls.body = 0;
    calls.guarded = 0;
  });
  afterAll(async () => app?.close());

  it.each([
    { path: 'success', status: 202, body: { state: 'synthetic' } },
    {
      path: 'guard-denied',
      status: 401,
      body: { message: 'Unauthorized', statusCode: 401 },
    },
    {
      path: 'bad-request',
      status: 400,
      body: {
        message: 'Synthetic rejection',
        error: 'Bad Request',
        statusCode: 400,
      },
    },
    {
      path: 'unexpected',
      status: 500,
      body: { statusCode: 500, message: 'Internal server error' },
    },
  ])(
    'keeps no-store for $path without rewriting its result',
    async (fixture) => {
      const response = await fetch(`${url}/synthetic-auth/${fixture.path}`, {
        method: 'POST',
      });

      expect(response.status).toBe(fixture.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(fixture.body);
      expect(calls.guarded).toBe(0);
      if (fixture.path === 'success') {
        expect(response.headers.get('x-synthetic')).toBe('unchanged');
      }
    },
  );

  it.each([
    { label: 'malformed JSON', body: '{"unfinished":', status: 400 },
    {
      label: 'oversized JSON',
      body: JSON.stringify({ synthetic: 'x'.repeat(128) }),
      status: 413,
    },
  ])(
    'keeps no-store on $label before controller execution',
    async (fixture) => {
      const response = await fetch(`${url}/synthetic-auth/body`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: fixture.body,
      });

      expect(response.status).toBe(fixture.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await response.arrayBuffer();
      expect(calls.body).toBe(0);
    },
  );
});
