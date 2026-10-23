import { URL } from 'node:url';

const SECURITY_FIELDS = new Set([
  'origin',
  'content-type',
  'x-nina-csrf-protection',
  'sec-fetch-site',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const JSON_TYPE =
  /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?$/i;

/** Unregistered admission policy; it establishes neither identity nor TLS. */
export class BrowserRequestPolicy {
  private readonly origin: string;

  constructor(origin: unknown) {
    try {
      if (typeof origin !== 'string' || origin.includes('*')) throw new Error();
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
        throw new Error();
      }
      this.origin = origin;
    } catch {
      throw new Error('Invalid browser request policy configuration');
    }
  }

  allowsAuthenticationPost(request: unknown): boolean {
    try {
      if (
        typeof request !== 'object' ||
        request === null ||
        !('method' in request) ||
        request.method !== 'POST' ||
        !('rawHeaders' in request)
      ) {
        return false;
      }
      const rawHeaders: unknown = request.rawHeaders;
      if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0)
        return false;

      const headers = new Map<string, string>();
      for (let index = 0; index < rawHeaders.length; index += 2) {
        const name: unknown = rawHeaders[index];
        const value: unknown = rawHeaders[index + 1];
        if (
          typeof name !== 'string' ||
          !HEADER_NAME.test(name) ||
          name.trim() !== name ||
          typeof value !== 'string'
        ) {
          return false;
        }
        const field = name.toLowerCase();
        if (!SECURITY_FIELDS.has(field)) continue;
        if (headers.has(field)) return false;
        headers.set(field, value);
      }

      const contentType = headers.get('content-type');
      const site = headers.get('sec-fetch-site');
      return (
        headers.get('origin') === this.origin &&
        // Public nonsecret marker: never a token or authentication credential.
        headers.get('x-nina-csrf-protection') === '1' &&
        contentType !== undefined &&
        // No outer whitespace, including final newlines accepted by regexp `$`.
        contentType.trim() === contentType &&
        JSON_TYPE.test(contentType) &&
        (site === undefined || site === 'same-origin')
      );
    } catch {
      // Unknown inputs can include throwing accessors/proxies; fail closed.
      return false;
    }
  }
}
