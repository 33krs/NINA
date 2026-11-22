import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { AccessCredentialService } from './access-credential.service';
import { createBrowserAuthJson } from './browser-auth-json.middleware';
import { BrowserLoginAttempts } from './browser-login-attempts';
import { BrowserSessionCookies } from './browser-session-cookies';
import type { BrowserSessionCompositionConfig } from './browser-session-composition';
import type { SessionService } from './session.service';

export interface LocalAuthConfig {
  readonly https: { readonly key: Buffer; readonly cert: Buffer };
  readonly browser: BrowserSessionCompositionConfig;
}

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    throw new Error();
  return value;
}

function positiveInteger(env: Environment, name: string): number {
  const value = required(env, name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error();
  return number;
}

/** Reads local operator-provided material; never logs paths, keys, or values. */
export function loadLocalAuthConfig(env: Environment): LocalAuthConfig {
  try {
    const cert = readFileSync(required(env, 'NINA_TLS_CERT_FILE'));
    const key = readFileSync(required(env, 'NINA_TLS_KEY_FILE'));
    const tlsPrivate = createPrivateKey(key);
    const certificate = new X509Certificate(cert);
    const now = Date.now();
    if (
      !certificate.checkHost('localhost', { subject: 'never' }) ||
      !certificate.checkPrivateKey(tlsPrivate) ||
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) < now
    )
      throw new Error();
    createSecureContext({ key, cert });
    const privateKey = createPrivateKey(
      readFileSync(required(env, 'NINA_SIGNING_KEY_FILE')),
    );
    const publicKey = createPublicKey(privateKey);
    if (
      publicKey
        .export({ type: 'spki', format: 'der' })
        .equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    )
      throw new Error();
    const lifetimeSeconds = positiveInteger(env, 'NINA_AUTH_ACCESS_SECONDS');
    const browser: BrowserSessionCompositionConfig = {
      canonicalOrigin: 'https://localhost:3001',
      jsonLimits: {
        maxBytes: positiveInteger(env, 'NINA_AUTH_JSON_MAX_BYTES'),
        readTimeoutMs: positiveInteger(env, 'NINA_AUTH_JSON_TIMEOUT_MS'),
      },
      cookieConfig: {
        accessMaxAgeSeconds: lifetimeSeconds,
        refreshMaxAgeSeconds: positiveInteger(env, 'NINA_AUTH_REFRESH_SECONDS'),
      },
      attemptPolicy: {
        windowMs: positiveInteger(env, 'NINA_AUTH_ATTEMPT_WINDOW_MS'),
        maxAttemptsPerUsername: positiveInteger(
          env,
          'NINA_AUTH_ATTEMPTS_PER_USER',
        ),
        maxAttemptsGlobal: positiveInteger(env, 'NINA_AUTH_ATTEMPTS_GLOBAL'),
        maxTrackedUsernames: positiveInteger(env, 'NINA_AUTH_TRACKED_USERS'),
      },
      accessCredentialConfig: {
        privateKey,
        publicKey,
        lifetimeSeconds,
        issuer: required(env, 'NINA_AUTH_ISSUER'),
        audience: required(env, 'NINA_AUTH_AUDIENCE'),
      },
    };
    new BrowserLoginAttempts(browser.attemptPolicy);
    new BrowserSessionCookies(browser.cookieConfig);
    createBrowserAuthJson(browser.jsonLimits);
    new AccessCredentialService(
      {} as SessionService,
      browser.accessCredentialConfig,
    );
    return { https: { key, cert }, browser };
  } catch {
    throw new Error('Invalid local authentication configuration');
  }
}
