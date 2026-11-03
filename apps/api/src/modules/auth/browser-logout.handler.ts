import type { Request, RequestHandler, Response } from 'express';
import type { RefreshSessionRevocationService } from './refresh-session-revocation.service';
import type { SessionService } from './session.service';
import type { AccessCredentialService } from './access-credential.service';
import {
  createBrowserAuthJson,
  type BrowserAuthJsonLimits,
} from './browser-auth-json.middleware';
import {
  BrowserSessionCookies,
  type BrowserSessionCookieConfig,
} from './browser-session-cookies';
import { BrowserSessionCookieReader } from './browser-session-cookie-reader';
import { browserAuthNoStore } from './browser-auth-no-store.middleware';
import { BrowserRequestPolicy } from './browser-request-policy';

export interface BrowserLogoutServices {
  readonly refresh: Pick<RefreshSessionRevocationService, 'revoke'>;
  readonly sessions: Pick<SessionService, 'revoke'>;
  readonly access: Pick<AccessCredentialService, 'verifySession'>;
}

export interface BrowserLogoutConfig {
  readonly canonicalOrigin: string;
  readonly jsonLimits: BrowserAuthJsonLimits;
  readonly cookieConfig: BrowserSessionCookieConfig;
}

/** Unregistered composition: mount before other body readers, not in AppModule. */
export function createBrowserLogoutHandler(
  services: BrowserLogoutServices,
  config: BrowserLogoutConfig,
): RequestHandler {
  const policy = new BrowserRequestPolicy(config.canonicalOrigin);
  const read = createBrowserAuthJson(config.jsonLimits);
  const cookies = new BrowserSessionCookies(config.cookieConfig);
  const input = new BrowserSessionCookieReader();
  const { refresh, sessions, access } = services;

  function available(response: Response): boolean {
    // Normal body completion may destroy the request without aborting its response.
    return (
      !response.destroyed && !response.writableEnded && !response.headersSent
    );
  }

  function deny(response: Response, status: number): void {
    if (!available(response)) {
      response.destroy();
      return;
    }
    try {
      response.shouldKeepAlive = false;
      response.statusCode = status;
      response.setHeader('Connection', 'close');
      response.setHeader('Content-Type', 'application/json');
      response.end('{"message":"Authentication failed"}');
    } catch {
      response.destroy();
    }
  }

  async function logout(request: Request, response: Response): Promise<void> {
    let dispatchAttempted = false;
    try {
      if (!available(response)) return;
      const body: unknown = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        return deny(response, 400);
      const extracted = input.read(request);
      if (!extracted || (!extracted.refreshToken && !extracted.accessToken))
        return deny(response, 401);
      const binding = extracted.accessToken
        ? await access.verifySession(extracted.accessToken)
        : null;
      // Verification can outlive the client; never begin a new write afterward.
      if (!available(response)) return;
      let revoked: boolean;
      if (extracted.refreshToken) {
        // Present refresh is the authority, never an access-only fallback.
        // A supplied undefined binding is deliberately invalid in this service.
        revoked = binding
          ? await refresh.revoke(extracted.refreshToken, binding)
          : await refresh.revoke(extracted.refreshToken);
      } else {
        if (!binding) return deny(response, 401);
        revoked = await sessions.revoke(binding.sessionId, binding.account.id);
      }
      if (!available(response)) return;
      if (revoked !== true) return deny(response, 401);
      const pair = cookies.clear();
      response.setHeader('Set-Cookie', pair);
      response.statusCode = 204;
      // Once end is attempted, even a thrown write can have an ambiguous outcome.
      dispatchAttempted = true;
      response.end();
    } catch {
      if (dispatchAttempted || response.headersSent) {
        response.destroy();
        return;
      }
      try {
        response.removeHeader('Set-Cookie');
      } catch {
        response.destroy();
        return;
      }
      // Revocation may already have committed: never compensate, recover or retry.
      deny(response, 500);
    }
  }

  return (request, response) => {
    try {
      browserAuthNoStore(request, response, () => {
        if (!policy.allowsAuthenticationPost(request))
          return deny(response, 403);
        read(request, response, () => {
          void logout(request, response);
        });
      });
    } catch {
      response.destroy();
    }
  };
}
