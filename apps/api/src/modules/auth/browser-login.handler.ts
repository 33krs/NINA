import type { Request, RequestHandler, Response } from 'express';
import type { SessionCreationService } from './session-creation.service';
import type { AccessCredentialService } from './access-credential.service';
import type { SessionService } from './session.service';
import {
  createBrowserAuthJson,
  type BrowserAuthJsonLimits,
} from './browser-auth-json.middleware';
import {
  BrowserSessionCookies,
  type BrowserSessionCookieConfig,
} from './browser-session-cookies';
import { browserAuthNoStore } from './browser-auth-no-store.middleware';
import { BrowserRequestPolicy } from './browser-request-policy';
import { BrowserLoginInputReader } from './browser-login-input-reader';

export interface BrowserLoginServices {
  readonly creation: Pick<SessionCreationService, 'create'>;
  readonly access: Pick<AccessCredentialService, 'issue'>;
  readonly sessions: Pick<SessionService, 'revoke'>;
}

export interface BrowserLoginConfig {
  readonly canonicalOrigin: string;
  readonly jsonLimits: BrowserAuthJsonLimits;
  readonly cookieConfig: BrowserSessionCookieConfig;
}

interface OwnedSession {
  readonly id: string;
  readonly ownerId: string;
}

/** Unregistered composition: mount before any other body parser, not in AppModule. */
export function createBrowserLoginHandler(
  services: BrowserLoginServices,
  config: BrowserLoginConfig,
): RequestHandler {
  const policy = new BrowserRequestPolicy(config.canonicalOrigin);
  const read = createBrowserAuthJson(config.jsonLimits);
  const cookies = new BrowserSessionCookies(config.cookieConfig);
  const input = new BrowserLoginInputReader();
  const { creation, access, sessions } = services;

  function available(response: Response): boolean {
    // A normally completed IncomingMessage may be destroyed; inspect the response.
    return (
      !response.destroyed && !response.writableEnded && !response.headersSent
    );
  }

  function discardCookies(response: Response): void {
    try {
      response.removeHeader('Set-Cookie');
    } catch {
      response.destroy();
    }
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

  async function login(request: Request, response: Response): Promise<void> {
    let owned: OwnedSession | undefined;
    let dispatchAttempted = false;
    try {
      if (!available(response)) return;
      const body: unknown = request.body;
      const credentials = input.read(body);
      if (!credentials) return deny(response, 400);
      const created = await creation.create(
        credentials.username,
        credentials.password,
        null,
      );
      if (!created) return deny(response, 401);
      // Snapshot only identifiers returned by successful creation, never client IDs.
      const { id, account, refreshToken } = created;
      owned = { id, ownerId: account.id };
      const authVersion = account.authVersion;
      if (!available(response)) throw new Error();
      const accessToken = await access.issue(id, owned.ownerId, authVersion);
      if (!accessToken || !available(response)) throw new Error();
      const pair = cookies.issue({ accessToken, refreshToken });
      if (!pair) throw new Error();
      response.setHeader('Set-Cookie', pair);
      response.statusCode = 204;
      // An attempted write can have an ambiguous outcome even when end throws.
      dispatchAttempted = true;
      response.end();
    } catch {
      if (dispatchAttempted || response.headersSent) {
        response.destroy();
        return;
      }
      discardCookies(response);
      if (owned) {
        try {
          // One owned compensation attempt; false/throw proves no rollback.
          await sessions.revoke(owned.id, owned.ownerId);
        } catch {
          /* Do not retry an ambiguous cleanup operation. */
        }
      }
      deny(response, 500);
    }
  }

  return (request, response) => {
    try {
      browserAuthNoStore(request, response, () => {
        if (!policy.allowsAuthenticationPost(request))
          return deny(response, 403);
        read(request, response, () => {
          void login(request, response);
        });
      });
    } catch {
      response.destroy();
    }
  };
}
