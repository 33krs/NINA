import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalAuthConfig } from './local-auth-config';

let directory: string;
let environment: Record<string, string | undefined>;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'nina-local-auth-'));
  const tlsKey = join(directory, 'tls-key.pem');
  const tlsCert = join(directory, 'tls-cert.pem');
  const signingKey = join(directory, 'signing-key.pem');
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
      tlsKey,
      '-out',
      tlsCert,
    ],
    { stdio: 'ignore' },
  );
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(
    signingKey,
    signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  environment = {
    NINA_TLS_CERT_FILE: tlsCert,
    NINA_TLS_KEY_FILE: tlsKey,
    NINA_SIGNING_KEY_FILE: signingKey,
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
  };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('local HTTPS authentication configuration', () => {
  it('loads explicit private material and a loopback-only browser origin', () => {
    const loaded = loadLocalAuthConfig(environment);
    expect(loaded.browser.canonicalOrigin).toBe('https://localhost:3001');
    expect(loaded.browser.accessCredentialConfig.privateKey.type).toBe(
      'private',
    );
    expect(loaded.browser.accessCredentialConfig.publicKey.type).toBe('public');
    expect(loaded.browser.attemptPolicy.maxAttemptsGlobal).toBe(100);
    expect(loaded.https.key.length).toBeGreaterThan(0);
    expect(loaded.https.cert.length).toBeGreaterThan(0);
  });
  it('rejects missing or invalid settings without disclosing their values', () => {
    for (const changes of [
      { NINA_TLS_KEY_FILE: undefined },
      { NINA_AUTH_JSON_MAX_BYTES: '0' },
      { NINA_AUTH_ACCESS_SECONDS: '901' },
      { NINA_TLS_KEY_FILE: environment.NINA_SIGNING_KEY_FILE },
      { NINA_SIGNING_KEY_FILE: environment.NINA_TLS_KEY_FILE },
    ]) {
      expect(() => loadLocalAuthConfig({ ...environment, ...changes })).toThrow(
        'Invalid local authentication configuration',
      );
    }
  });

  it('rejects each omitted required runtime setting', () => {
    for (const name of Object.keys(environment)) {
      const candidate = { ...environment };
      delete candidate[name];
      expect(() => loadLocalAuthConfig(candidate)).toThrow(
        'Invalid local authentication configuration',
      );
    }
  });
});
