import type { Request, RequestHandler, Response } from 'express';
import type { RefreshRotationService } from './refresh-rotation.service';
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

export interface BrowserRefreshServices {
  readonly rotation: Pick<RefreshRotationService, 'rotate'>;
  readonly access: Pick<AccessCredentialService, 'issue'>;
}

export interface BrowserRefreshConfig {
  readonly canonicalOrigin: string;
  readonly jsonLimits: BrowserAuthJsonLimits;
  readonly cookieConfig: BrowserSessionCookieConfig;
}

/** Unregistered composition: mount before other body readers, not in AppModule. */
export function createBrowserRefreshHandler(
  services: BrowserRefreshServices,
  config: BrowserRefreshConfig,
): RequestHandler {
  const policy = new BrowserRequestPolicy(config.canonicalOrigin);
  const read = createBrowserAuthJson(config.jsonLimits);
  const cookies = new BrowserSessionCookies(config.cookieConfig);
  const input = new BrowserSessionCookieReader();
  const { rotation, access } = services;

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

  async function refresh(request: Request, response: Response): Promise<void> {
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
      if (!extracted?.refreshToken) return deny(response, 401);
      const rotated = await rotation.rotate(extracted.refreshToken);
      if (!rotated) return deny(response, 401);
      if (!available(response)) return;
      const { id, account, refreshToken } = rotated;
      const accessToken = await access.issue(
        id,
        account.id,
        account.authVersion,
      );
      if (!accessToken || !available(response)) throw new Error();
      const pair = cookies.issue({ accessToken, refreshToken });
      if (!pair) throw new Error();
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
      // Rotation concerns an existing session: never compensate, recover or retry.
      deny(response, 500);
    }
  }

  return (request, response) => {
    try {
      browserAuthNoStore(request, response, () => {
        if (!policy.allowsAuthenticationPost(request))
          return deny(response, 403);
        read(request, response, () => {
          void refresh(request, response);
        });
      });
    } catch {
      response.destroy();
    }
  };
}
