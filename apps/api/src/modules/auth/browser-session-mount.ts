import type { Express } from 'express';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  createBrowserSessionHandlers,
  type BrowserSessionCompositionConfig,
} from './browser-session-composition';

/** Mount before any body parser; the caller owns the application and its lifecycle. */
export function mountBrowserSessionRoutes(
  app: Express,
  prisma: PrismaService,
  config: BrowserSessionCompositionConfig,
): void {
  const handlers = createBrowserSessionHandlers(prisma, config);
  app.post(/^\/auth\/login$/, handlers.login);
  app.post(/^\/auth\/refresh$/, handlers.refresh);
  app.post(/^\/auth\/logout$/, handlers.logout);
}
