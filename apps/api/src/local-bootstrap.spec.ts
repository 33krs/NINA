import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import { PrismaService } from './prisma/prisma.service';
import * as configModule from './modules/auth/local-auth-config';
import * as mountModule from './modules/auth/browser-session-mount';
import { localStartupFailureMessage, startLocalApi } from './local-bootstrap';

afterEach(() => jest.restoreAllMocks());

describe('local authentication API bootstrap', () => {
  it('mounts the shared handlers before parsers and listens only on loopback', async () => {
    const events: string[] = [];
    const prisma = {} as PrismaService;
    const express = {} as Express;
    const config = { https: {}, browser: {} } as configModule.LocalAuthConfig;
    const app = {
      get: jest.fn(() => prisma),
      getHttpAdapter: () => ({ getInstance: () => express }),
      useBodyParser: jest.fn((kind: string) => events.push(kind)),
      listen: jest.fn(async (port: number, host: string) => {
        events.push(`${host}:${port}`);
      }),
      close: jest.fn(async () => undefined),
    } as unknown as NestExpressApplication;
    const load = jest
      .spyOn(configModule, 'loadLocalAuthConfig')
      .mockReturnValue(config);
    const create = jest.spyOn(NestFactory, 'create').mockResolvedValue(app);
    const mount = jest
      .spyOn(mountModule, 'mountBrowserSessionRoutes')
      .mockImplementation(() => {
        events.push('mount');
      });
    const env = {};

    await expect(startLocalApi(env)).resolves.toBe(app);
    expect(load).toHaveBeenCalledWith(env);
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      bodyParser: false,
      httpsOptions: config.https,
      abortOnError: false,
      logger: ['log'],
    });
    expect(app.get).toHaveBeenCalledWith(PrismaService);
    expect(mount).toHaveBeenCalledWith(express, prisma, config.browser);
    expect(events).toEqual(['mount', 'json', 'urlencoded', '127.0.0.1:3001']);
  });

  it('does not create or listen when configuration is invalid', async () => {
    jest.spyOn(configModule, 'loadLocalAuthConfig').mockImplementation(() => {
      throw new Error('Invalid local authentication configuration');
    });
    const create = jest.spyOn(NestFactory, 'create');
    await expect(startLocalApi({})).rejects.toThrow(
      'Invalid local authentication configuration',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('closes the owned app when mounting fails before listening', async () => {
    const app = {
      get: () => ({}),
      getHttpAdapter: () => ({ getInstance: () => ({}) }),
      listen: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    } as unknown as NestExpressApplication;
    jest.spyOn(configModule, 'loadLocalAuthConfig').mockReturnValue({
      https: {},
      browser: {},
    } as configModule.LocalAuthConfig);
    jest.spyOn(NestFactory, 'create').mockResolvedValue(app);
    jest
      .spyOn(mountModule, 'mountBrowserSessionRoutes')
      .mockImplementation(() => {
        throw new Error('mount failed');
      });
    await expect(startLocalApi({})).rejects.toThrow('mount failed');
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('reports configuration, port and database failures without exposing error details', () => {
    expect(
      localStartupFailureMessage(
        new Error('Invalid local authentication configuration'),
      ),
    ).toBe('Invalid local authentication configuration');
    expect(localStartupFailureMessage({ code: 'EADDRINUSE' })).toBe(
      'Local HTTPS API port is already in use',
    );
    expect(localStartupFailureMessage({ errorCode: 'P1001' })).toBe(
      'Local API cannot reach the database',
    );
    expect(localStartupFailureMessage(new Error('sensitive details'))).toBe(
      'Unable to start the local API',
    );
  });
});
