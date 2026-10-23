import { Buffer } from 'node:buffer';

export interface BrowserSessionRequestCookies {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}

const ACCESS_NAME = '__Host-nina-access';
const REFRESH_NAME = '__Host-nina-refresh';
const INVALID_NAME = /[^!#$%&'*+.^_`|~0-9A-Za-z-]/;
const INVALID_VALUE = /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/;
const INVALID_BASE64URL = /[^A-Za-z0-9_-]/;

/** Internal parsing only; extracted values are not authenticated credentials. */
export class BrowserSessionCookieReader {
  read(request: unknown): BrowserSessionRequestCookies | null {
    try {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !('rawHeaders' in request)
      )
        return null;
      const headers: unknown = request.rawHeaders;
      if (!Array.isArray(headers)) return null;
      const length = headers.length;
      if (!Number.isSafeInteger(length) || length < 0 || length % 2 !== 0)
        return null;

      let cookie: string | undefined;
      for (let index = 0; index < length; index += 2) {
        const name: unknown = headers[index];
        const value: unknown = headers[index + 1];
        if (
          typeof name !== 'string' ||
          !name ||
          INVALID_NAME.test(name) ||
          typeof value !== 'string'
        )
          return null;
        if (name.toLowerCase() !== 'cookie') continue;
        if (cookie !== undefined) return null;
        cookie = value;
      }

      let accessToken: string | null = null;
      let refreshToken: string | null = null;
      if (cookie === undefined) return { accessToken, refreshToken };
      if (
        !cookie ||
        cookie.length > 8192 ||
        cookie.startsWith(' ') ||
        /[^\x20-\x7e]/.test(cookie)
      )
        return null;

      for (const segment of cookie.split(';')) {
        // Only separator spaces are discarded; names and values stay exact.
        const pair = segment.replace(/^ +/, '');
        const separator = pair.indexOf('=');
        if (separator < 1) return null;
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (INVALID_NAME.test(name) || INVALID_VALUE.test(value)) return null;
        if (name === ACCESS_NAME) {
          if (accessToken !== null || value.length > 4096) return null;
          const parts = value.split('.');
          if (
            parts.length !== 3 ||
            parts.some((part) => !part || INVALID_BASE64URL.test(part))
          )
            return null;
          accessToken = value;
        } else if (name === REFRESH_NAME) {
          if (
            refreshToken !== null ||
            value.length !== 43 ||
            INVALID_BASE64URL.test(value)
          )
            return null;
          const bytes = Buffer.from(value, 'base64url');
          if (bytes.length !== 32 || bytes.toString('base64url') !== value)
            return null;
          refreshToken = value;
        }
      }
      return { accessToken, refreshToken };
    } catch {
      // Unknown objects may throw; never expose material or partial extraction.
      return null;
    }
  }
}
