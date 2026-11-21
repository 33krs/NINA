import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from './prisma/prisma.service';
import { startLocalApi } from './local-bootstrap';

describe('local HTTPS bootstrap', () => {
  let directory: string;
  let app: NestExpressApplication;
  let port: number;
  let ca: Buffer;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'nina-https-bootstrap-'));
    const key = join(directory, 'tls-key.pem');
    const cert = join(directory, 'tls-cert.pem');
    const signing = join(directory, 'signing-key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(
      signing,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    ca = readFileSync(cert);
    jest
      .spyOn(PrismaService.prototype, 'onModuleInit')
      .mockResolvedValue(undefined);
    jest
      .spyOn(PrismaService.prototype, 'onModuleDestroy')
      .mockResolvedValue(undefined);
    app = await startLocalApi(
      {
        NINA_TLS_CERT_FILE: cert,
        NINA_TLS_KEY_FILE: key,
        NINA_SIGNING_KEY_FILE: signing,
        NINA_AUTH_ISSUER: 'test-issuer',
        NINA_AUTH_AUDIENCE: 'test-audience',
        NINA_AUTH_ACCESS_SECONDS: '60',
        NINA_AUTH_REFRESH_SECONDS: '3600',
        NINA_AUTH_JSON_MAX_BYTES: '1024',
        NINA_AUTH_JSON_TIMEOUT_MS: '1000',
        NINA_AUTH_ATTEMPT_WINDOW_MS: '60000',
        NINA_AUTH_ATTEMPTS_PER_USER: '10',
        NINA_AUTH_ATTEMPTS_GLOBAL: '100',
        NINA_AUTH_TRACKED_USERS: '100',
      },
      0,
    );
    const address = app.getHttpServer().address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    port = address.port;
  });
  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function send(
    method: string,
    path: string,
    origin = 'https://localhost:3001',
  ) {
    return new Promise<{
      status: number | undefined;
      body: string;
      cookie: unknown;
      cache: unknown;
    }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          servername: 'localhost',
          port,
          path,
          method,
          ca,
          headers:
            method === 'POST'
              ? {
                  Origin: origin,
                  'Content-Type': 'application/json',
                  'X-Nina-Csrf-Protection': '1',
                }
              : {},
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
      req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
      req.end(method === 'POST' ? '{}' : undefined);
    });
  }

  it('mounts auth before default parsing while preserving the clinical guard', async () => {
    expect(await send('GET', '/')).toMatchObject({ status: 200 });
    expect(await send('GET', '/patients')).toMatchObject({ status: 401 });
    for (const [path, status] of [
      ['/auth/login', 400],
      ['/auth/refresh', 401],
      ['/auth/logout', 401],
    ] as const) {
      const result = await send('POST', path);
      expect(result).toMatchObject({
        status,
        body: '{"message":"Authentication failed"}',
        cookie: undefined,
        cache: 'no-store',
      });
    }
    expect(
      await send('POST', '/auth/login', 'https://untrusted.invalid'),
    ).toMatchObject({ status: 403, cookie: undefined });
  });
});
