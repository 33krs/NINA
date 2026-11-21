import { describe, expect, it, jest } from '@jest/globals';
import type { Express, RequestHandler } from 'express';
import type { PrismaService } from '../../prisma/prisma.service';
import * as composition from './browser-session-composition';
import { mountBrowserSessionRoutes } from './browser-session-mount';

describe('browser session route mounting', () => {
  it('constructs one shared graph before mounting only the three exact routes', () => {
    const post = jest.fn();
    const app = { post } as unknown as Express;
    const prisma = {} as PrismaService;
    const config = {} as composition.BrowserSessionCompositionConfig;
    const login: RequestHandler = jest.fn();
    const refresh: RequestHandler = jest.fn();
    const logout: RequestHandler = jest.fn();
    const factory = jest
      .spyOn(composition, 'createBrowserSessionHandlers')
      .mockReturnValue({ login, refresh, logout });

    try {
      mountBrowserSessionRoutes(app, prisma, config);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith(prisma, config);
      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls).toEqual([
        [/^\/auth\/login$/, login],
        [/^\/auth\/refresh$/, refresh],
        [/^\/auth\/logout$/, logout],
      ]);
    } finally {
      factory.mockRestore();
    }
  });

  it('mounts nothing when construction rejects configuration', () => {
    const post = jest.fn();
    const app = { post } as unknown as Express;
    const factory = jest
      .spyOn(composition, 'createBrowserSessionHandlers')
      .mockImplementation(() => {
        throw new Error('invalid configuration');
      });
    try {
      expect(() =>
        mountBrowserSessionRoutes(
          app,
          {} as PrismaService,
          {} as composition.BrowserSessionCompositionConfig,
        ),
      ).toThrow('invalid configuration');
      expect(post).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });
});
