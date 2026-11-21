import { describe, expect, it, jest } from '@jest/globals';
import express, { type Express, type Request, type Response } from 'express';
import {
  IncomingMessage,
  ServerResponse,
  request as httpRequest,
} from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mountBrowserSessionRoutes } from './browser-session-mount';
import type { BrowserSessionCompositionConfig } from './browser-session-composition';
import type { PrismaService } from '../../prisma/prisma.service';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function config(): BrowserSessionCompositionConfig {
  return {
    canonicalOrigin: 'https://localhost',
    jsonLimits: { maxBytes: 1024, readTimeoutMs: 50 },
    cookieConfig: { accessMaxAgeSeconds: 60, refreshMaxAgeSeconds: 3600 },
    attemptPolicy: {
      windowMs: 60000,
      maxAttemptsPerUsername: 10,
      maxAttemptsGlobal: 10,
      maxTrackedUsernames: 10,
    },
    accessCredentialConfig: {
      ...keys,
      issuer: 'test',
      audience: 'test',
      lifetimeSeconds: 60,
    },
  };
}
function fixture() {
  const writes = jest.fn(() => {
    throw new Error('Unexpected database access');
  });
  const prisma = {
    $transaction: writes,
    user: { findUnique: writes },
  } as unknown as PrismaService;
  return { prisma, writes };
}
function request(
  app: Express,
  path: string,
  method = 'POST',
  raw = '{}',
  origin = 'https://localhost',
) {
  return new Promise<{
    status: number;
    body: string;
    cookie: unknown;
    cache: unknown;
  }>((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.url = path;
    req.method = method;
    req.rawHeaders = [
      'Origin',
      origin,
      'Content-Type',
      'application/json',
      'Content-Length',
      String(Buffer.byteLength(raw)),
      'X-Nina-Csrf-Protection',
      '1',
    ];
    const res = new ServerResponse(req);
    res.end = ((body?: unknown) => {
      resolve({
        status: res.statusCode,
        body: body === undefined ? '' : String(body),
        cookie: res.getHeader('Set-Cookie'),
        cache: res.getHeader('Cache-Control'),
      });
      return res;
    }) as typeof res.end;
    app(req as Request, res as Response, (error?: unknown) => {
      if (error) reject(error);
      else {
        res.statusCode = 404;
        res.end('unmatched');
      }
    });
    req.push(Buffer.from(raw));
    req.push(null);
  });
}

describe('independent browser mount verification', () => {
  it('isolates exact route paths/methods and runs handlers before a later parser', async () => {
    const { prisma, writes } = fixture();
    const app = express();
    mountBrowserSessionRoutes(app, prisma, config());
    const parser = jest.fn((_req, _res, next: () => void) => next());
    app.use(parser);
    for (const path of ['/auth/login', '/auth/refresh', '/auth/logout']) {
      const result = await request(app, path);
      expect(result.status).toBe(path === '/auth/login' ? 400 : 401);
      expect(result.cookie).toBeUndefined();
      expect(result.cache).toContain('no-store');
    }
    expect(parser).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    for (const path of [
      '/auth/login/',
      '/AUTH/login',
      '/auth/login/x',
      '/auth/login%2f',
      '/api/auth/login',
    ]) {
      expect((await request(app, path)).status).toBe(404);
    }
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE'])
      expect((await request(app, '/auth/login', method)).status).toBe(404);
    expect((await request(app, '/auth/login?next=/patients')).status).toBe(400);
    expect(parser).toHaveBeenCalledTimes(9);
  });
  it('rejects wrong origins and duplicate JSON keys before database calls', async () => {
    const { prisma, writes } = fixture();
    const app = express();
    mountBrowserSessionRoutes(app, prisma, config());
    expect(
      await request(app, '/auth/login', 'POST', '{}', 'https://evil.test'),
    ).toMatchObject({
      status: 403,
      body: '{"message":"Authentication failed"}',
      cookie: undefined,
    });
    expect(
      await request(
        app,
        '/auth/login',
        'POST',
        '{"username":"a","username":"b"}',
      ),
    ).toMatchObject({
      status: 400,
      body: '{"message":"Invalid request body"}',
      cookie: undefined,
    });
    expect(writes).not.toHaveBeenCalled();
  });
  it('fails closed when incorrectly mounted after the real JSON parser', async () => {
    const { prisma, writes } = fixture();
    const app = express();
    app.use(express.json());
    const parsed = jest.fn((req: Request, _res: Response, next: () => void) => {
      expect(req.body).toEqual({});
      expect(Readable.isDisturbed(req)).toBe(true);
      next();
    });
    app.use(parsed);
    mountBrowserSessionRoutes(app, prisma, config());
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const port = (server.address() as AddressInfo).port;
      for (const path of ['/auth/login', '/auth/refresh', '/auth/logout']) {
        const result = await new Promise<{
          status: number | undefined;
          body: string;
          cookie: unknown;
          cache: unknown;
        }>((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path,
              method: 'POST',
              headers: {
                Origin: 'https://localhost',
                'Content-Type': 'application/json',
                'X-Nina-Csrf-Protection': '1',
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => {
                body += chunk;
              });
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  body,
                  cookie: res.headers['set-cookie'],
                  cache: res.headers['cache-control'],
                }),
              );
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end('{}');
        });
        expect(result).toMatchObject({
          status: 400,
          body: '{"message":"Invalid request body"}',
          cookie: undefined,
          cache: 'no-store',
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(parsed).toHaveBeenCalledTimes(3);
    expect(writes).not.toHaveBeenCalled();
  });
  it('leaves a real Express application untouched for invalid real configuration', async () => {
    const { prisma, writes } = fixture();
    for (const invalid of [
      { ...config(), canonicalOrigin: 'http://localhost' },
      { ...config(), jsonLimits: { maxBytes: 0, readTimeoutMs: 50 } },
    ]) {
      const app = express();
      expect(() => mountBrowserSessionRoutes(app, prisma, invalid)).toThrow();
      for (const path of ['/auth/login', '/auth/refresh', '/auth/logout'])
        expect((await request(app, path)).status).toBe(404);
    }
    expect(writes).not.toHaveBeenCalled();
  });
});
