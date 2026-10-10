import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createClient } from 'redis';
import { env } from 'node:process';

export const LOCK_TTL_MS = 10000;
export const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export function createAppointmentRedis() {
  const client = createClient({
    url: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1500,
      socketTimeout: 1500,
      reconnectStrategy: false,
    },
  });
  client.on('error', () =>
    new Logger('AppointmentRedis').warn('Redis connection unavailable'),
  );
  return client;
}

@Injectable()
export class AppointmentLockService implements OnModuleDestroy {
  private readonly logger = new Logger(AppointmentLockService.name);
  private connecting?: Promise<unknown>;

  constructor(
    @Inject('APPOINTMENT_REDIS')
    private readonly redis: ReturnType<typeof createClient>,
  ) {}

  async acquire(key: string, owner: string): Promise<boolean> {
    if (!this.redis.isReady) {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    const result = await this.redis
      .withCommandOptions({ timeout: 1500 })
      .set(key, owner, { NX: true, PX: LOCK_TTL_MS });
    if (result === null) return false;
    if (result !== 'OK') throw new Error('Unexpected Redis acquisition result');
    return true;
  }

  async release(key: string, owner: string): Promise<void> {
    try {
      await this.redis
        .withCommandOptions({ timeout: 1500 })
        .eval(RELEASE_LOCK, { keys: [key], arguments: [owner] });
    } catch {
      // A committed reservation or original failure must not be replaced by cleanup failure.
      this.logger.warn('Reservation lock release failed; lease will expire');
    }
  }

  onModuleDestroy(): void {
    if (this.redis.isOpen) this.redis.destroy();
  }
}
