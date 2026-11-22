import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { loadLocalAuthConfig } from './modules/auth/local-auth-config';
import { mountBrowserSessionRoutes } from './modules/auth/browser-session-mount';

/** Classify common failures without exposing error text or configuration. */
export function localStartupFailureMessage(error: unknown): string {
  try {
    if (
      error instanceof Error &&
      error.message === 'Invalid local authentication configuration'
    )
      return 'Invalid local authentication configuration';
    if (typeof error === 'object' && error !== null) {
      if ('code' in error && error.code === 'EADDRINUSE')
        return 'Local HTTPS API port is already in use';
      if ('errorCode' in error && error.errorCode === 'P1001')
        return 'Local API cannot reach the database';
    }
  } catch {
    // Unknown thrown values can expose accessors that throw.
  }
  return 'Unable to start the local API';
}

/** Starts the API on loopback only, using operator-provided TLS and auth material. */
export async function startLocalApi(
  env: Readonly<Record<string, string | undefined>>,
  listenPort = 3001,
): Promise<NestExpressApplication> {
  const config = loadLocalAuthConfig(env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    httpsOptions: config.https,
    abortOnError: false,
    logger: ['log'],
  });
  try {
    const prisma = app.get(PrismaService);
    mountBrowserSessionRoutes(
      app.getHttpAdapter().getInstance(),
      prisma,
      config.browser,
    );
    app.useBodyParser('json');
    app.useBodyParser('urlencoded', { extended: true });
    await app.listen(listenPort, '127.0.0.1');
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
