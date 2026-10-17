import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createClient } from 'redis';

export const PHARMACY_REDIS = 'PHARMACY_REDIS';
export const PHARMACY_LOCK_TTL_MS = 10000;
export const PHARMACY_RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export function createPharmacyRedis(url: string) {
  if (typeof url !== 'string' || !url.trim())
    throw new TypeError('An explicit Redis URL is required');
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1500,
      socketTimeout: 1500,
      reconnectStrategy: false,
    },
  });
  client.on('error', () =>
    new Logger('PharmacyRedis').warn('Redis connection unavailable'),
  );
  return client;
}

@Injectable()
export class PharmacyLockService implements OnModuleDestroy {
  private readonly logger = new Logger(PharmacyLockService.name);
  private connecting?: Promise<unknown>;
  constructor(
    @Inject(PHARMACY_REDIS)
    private readonly redis: ReturnType<typeof createClient>,
  ) {}

  async acquire(key: string, owner: string): Promise<boolean> {
    if (!this.redis.isReady) {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    const reply = await this.redis
      .withCommandOptions({ timeout: 1500 })
      .set(key, owner, { NX: true, PX: PHARMACY_LOCK_TTL_MS });
    if (reply === null) return false;
    if (reply !== 'OK') throw new Error('Unexpected Redis acquisition result');
    return true;
  }

  async release(key: string, owner: string): Promise<void> {
    try {
      await this.redis
        .withCommandOptions({ timeout: 1500 })
        .eval(PHARMACY_RELEASE_LOCK, { keys: [key], arguments: [owner] });
    } catch {
      this.logger.warn('Dispensing lock release failed; lease will expire');
    }
  }

  onModuleDestroy(): void {
    if (this.redis.isOpen) this.redis.destroy();
  }
}
