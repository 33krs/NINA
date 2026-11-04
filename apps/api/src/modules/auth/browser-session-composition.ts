import type { RequestHandler } from 'express';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  AccessCredentialService,
  type AccessCredentialConfig,
} from './access-credential.service';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { SessionService } from './session.service';
import { SessionCreationService } from './session-creation.service';
import { RefreshRotationService } from './refresh-rotation.service';
import { RefreshSessionRevocationService } from './refresh-session-revocation.service';
import {
  createBrowserLoginHandler,
  type BrowserLoginConfig,
} from './browser-login.handler';
import { createBrowserRefreshHandler } from './browser-refresh.handler';
import { createBrowserLogoutHandler } from './browser-logout.handler';

export interface BrowserSessionCompositionConfig extends BrowserLoginConfig {
  readonly accessCredentialConfig: AccessCredentialConfig;
}

export interface BrowserSessionHandlers {
  readonly login: RequestHandler;
  readonly refresh: RequestHandler;
  readonly logout: RequestHandler;
}

/** Inert, unregistered graph; Prisma lifecycle and route mounting remain external. */
export function createBrowserSessionHandlers(
  prisma: PrismaService,
  config: BrowserSessionCompositionConfig,
): BrowserSessionHandlers {
  if (!prisma || typeof prisma !== 'object')
    throw new TypeError('An owned Prisma service is required');
  const credentials = new CredentialAuthenticationService(prisma);
  const sessions = new SessionService(prisma);
  const creation = new SessionCreationService(prisma, credentials);
  const rotation = new RefreshRotationService(prisma);
  const refresh = new RefreshSessionRevocationService(prisma);
  // Existing constructors own origin, parser, cookie and RS256 validation.
  const access = new AccessCredentialService(
    sessions,
    config.accessCredentialConfig,
  );
  return {
    login: createBrowserLoginHandler({ creation, access, sessions }, config),
    refresh: createBrowserRefreshHandler({ rotation, access }, config),
    logout: createBrowserLogoutHandler({ refresh, sessions, access }, config),
  };
}
