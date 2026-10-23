import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { AuthenticatedAccount } from './credential-authentication.service';
import type { SessionService } from './session.service';

export interface AccessCredentialConfig {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly issuer: string;
  readonly audience: string;
  readonly lifetimeSeconds: number;
}

const ACCESS_TYPE = 'nina-access+jwt';
const MAX_TOKEN_LENGTH = 8192;
const CLAIMS = ['sub', 'sid', 'authVersion', 'iat', 'exp', 'iss', 'aud'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647
  );
}

function isDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 256 && value.trim().length > 0
  );
}

/** Internal only: deliberately absent from application providers and routes. */
export class AccessCredentialService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly lifetimeSeconds: number;

  constructor(
    private readonly sessions: SessionService,
    config: AccessCredentialConfig,
  ) {
    try {
      const { privateKey, publicKey, issuer, audience, lifetimeSeconds } =
        config;
      if (
        !isLabel(issuer) ||
        !isLabel(audience) ||
        !Number.isInteger(lifetimeSeconds) ||
        lifetimeSeconds < 1 ||
        lifetimeSeconds > 900 ||
        !(privateKey instanceof KeyObject) ||
        !(publicKey instanceof KeyObject) ||
        privateKey.type !== 'private' ||
        publicKey.type !== 'public' ||
        privateKey.asymmetricKeyType !== 'rsa' ||
        publicKey.asymmetricKeyType !== 'rsa' ||
        (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
      // Independent local copies prevent caller-owned configuration changes.
      this.privateKey = createPrivateKey({
        key: privateKey.export({ type: 'pkcs8', format: 'der' }),
        type: 'pkcs8',
        format: 'der',
      });
      this.publicKey = createPublicKey({
        key: publicKey.export({ type: 'spki', format: 'der' }),
        type: 'spki',
        format: 'der',
      });
      const derived = createPublicKey(this.privateKey).export({
        type: 'spki',
        format: 'der',
      });
      if (
        !derived.equals(this.publicKey.export({ type: 'spki', format: 'der' }))
      )
        throw new Error();
      this.issuer = issuer;
      this.audience = audience;
      this.lifetimeSeconds = lifetimeSeconds;
    } catch {
      throw new Error('Invalid access credential configuration');
    }
  }

  async issue(
    sessionId: unknown,
    ownerId: unknown,
    authVersion: unknown,
  ): Promise<string | null> {
    if (!isId(sessionId) || !isId(ownerId) || !isVersion(authVersion))
      return null;
    try {
      if (!(await this.sessions.validate(sessionId, ownerId, authVersion)))
        return null;
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + this.lifetimeSeconds;
      if (!isDate(iat) || !isDate(exp)) return null;
      return jwt.sign(
        { sub: ownerId, sid: sessionId, authVersion, iat, exp },
        this.privateKey,
        {
          algorithm: 'RS256',
          issuer: this.issuer,
          audience: this.audience,
          header: { alg: 'RS256', typ: ACCESS_TYPE },
        },
      );
    } catch {
      return null;
    }
  }

  async verify(token: unknown): Promise<AuthenticatedAccount | null> {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    )
      return null;
    try {
      const verified = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
        complete: true,
        clockTolerance: 0,
      });
      const { header, payload } = verified;
      if (
        header.alg !== 'RS256' ||
        header.typ !== ACCESS_TYPE ||
        Object.keys(header).some((key) => key !== 'alg' && key !== 'typ') ||
        typeof payload === 'string' ||
        Object.keys(payload).length !== CLAIMS.length ||
        !CLAIMS.every((key) => Object.hasOwn(payload, key)) ||
        payload.iss !== this.issuer ||
        payload.aud !== this.audience ||
        !isId(payload.sub) ||
        !isId(payload.sid) ||
        !isVersion(payload.authVersion) ||
        !isDate(payload.iat) ||
        !isDate(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > this.lifetimeSeconds ||
        !this.isCurrent(payload.iat, payload.exp)
      )
        return null;
      const account = await this.sessions.validate(
        payload.sid,
        payload.sub,
        payload.authVersion,
      );
      // Online validation may await beyond expiry; no stale success is returned.
      return account && this.isCurrent(payload.iat, payload.exp)
        ? account
        : null;
    } catch {
      return null;
    }
  }

  private isCurrent(iat: number, exp: number): boolean {
    const now = Date.now() / 1000;
    return Number.isFinite(now) && iat <= now && now < exp;
  }
}
