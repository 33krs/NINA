import { Buffer } from 'node:buffer';

export interface BrowserSessionCookieConfig {
  readonly accessMaxAgeSeconds: number;
  readonly refreshMaxAgeSeconds: number;
}

export type BrowserSessionCookiePair = readonly [string, string];

const ACCESS_NAME = '__Host-nina-access';
const REFRESH_NAME = '__Host-nina-refresh';
const ATTRIBUTES = '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=';
const MAX_FIELD_BYTES = 4096;
const BASE64URL_INVALID = /[^A-Za-z0-9_-]/;

function isAge(value: unknown, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}

/** Response serialization only; callers must supply freshly issued credentials. */
export class BrowserSessionCookies {
  private readonly accessMaxAgeSeconds: number;
  private readonly refreshMaxAgeSeconds: number;

  constructor(config: BrowserSessionCookieConfig) {
    try {
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error();
      const { accessMaxAgeSeconds, refreshMaxAgeSeconds } = config;
      if (
        !isAge(accessMaxAgeSeconds, 900) ||
        !isAge(refreshMaxAgeSeconds, 34560000)
      )
        throw new Error();
      this.accessMaxAgeSeconds = accessMaxAgeSeconds;
      this.refreshMaxAgeSeconds = refreshMaxAgeSeconds;
    } catch {
      throw new Error('Invalid browser session cookie configuration');
    }
  }

  issue(credentials: unknown): BrowserSessionCookiePair | null {
    try {
      if (
        !credentials ||
        typeof credentials !== 'object' ||
        Array.isArray(credentials)
      )
        return null;
      const { accessToken, refreshToken } = credentials as Record<
        string,
        unknown
      >;
      if (
        typeof accessToken !== 'string' ||
        accessToken.length > MAX_FIELD_BYTES ||
        typeof refreshToken !== 'string' ||
        refreshToken.length !== 43
      )
        return null;
      const segments = accessToken.split('.');
      if (
        segments.length !== 3 ||
        segments.some(
          (part) => part.length === 0 || BASE64URL_INVALID.test(part),
        ) ||
        BASE64URL_INVALID.test(refreshToken) ||
        Buffer.from(refreshToken, 'base64url').toString('base64url') !==
          refreshToken
      )
        return null;
      const access = `${ACCESS_NAME}=${accessToken}${ATTRIBUTES}${this.accessMaxAgeSeconds}`;
      const refresh = `${REFRESH_NAME}=${refreshToken}${ATTRIBUTES}${this.refreshMaxAgeSeconds}`;
      // Values and attributes are ASCII; the full field length is its byte count.
      if (access.length > MAX_FIELD_BYTES || refresh.length > MAX_FIELD_BYTES)
        return null;
      return [access, refresh];
    } catch {
      // Getters/proxies must not leak input or return a partial credential pair.
      return null;
    }
  }

  /** Matching deletion fields only: this does not revoke the backend session. */
  clear(): BrowserSessionCookiePair {
    const expiration = '0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    return [
      `${ACCESS_NAME}=${ATTRIBUTES}${expiration}`,
      `${REFRESH_NAME}=${ATTRIBUTES}${expiration}`,
    ];
  }
}
