import { performance } from 'node:perf_hooks';
import { canonicalizeUsername } from './username';

export interface BrowserLoginAttemptPolicy {
  readonly windowMs: number;
  readonly maxAttemptsPerUsername: number;
  readonly maxAttemptsGlobal: number;
  readonly maxTrackedUsernames: number;
}

/** Count-all admission for one reused handler in one Node process/isolate. */
export class BrowserLoginAttempts {
  private readonly policy: BrowserLoginAttemptPolicy;
  private readonly attempts = new Map<string, number>();
  private startedAt: number | undefined;
  private lastNow: number | undefined;
  private total = 0;

  constructor(
    policy: BrowserLoginAttemptPolicy,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!policy || typeof now !== 'function')
      throw new TypeError('Invalid login attempt policy');
    const {
      windowMs,
      maxAttemptsPerUsername,
      maxAttemptsGlobal,
      maxTrackedUsernames,
    } = policy;
    const snapshot = {
      windowMs,
      maxAttemptsPerUsername,
      maxAttemptsGlobal,
      maxTrackedUsernames,
    };
    if (
      Object.values(snapshot).some(
        (value) => !Number.isSafeInteger(value) || value <= 0,
      )
    )
      throw new TypeError('Invalid login attempt policy');
    this.policy = Object.freeze(snapshot);
  }

  /** Synchronous reservation precedes all credential work; never refunded. */
  reserve(username: unknown): boolean {
    try {
      const canonical = canonicalizeUsername(username);
      const now = this.now();
      if (
        !Number.isFinite(now) ||
        now < 0 ||
        (this.lastNow !== undefined && now < this.lastNow)
      )
        return false;
      this.lastNow = now;
      if (
        this.startedAt === undefined ||
        now - this.startedAt >= this.policy.windowMs
      ) {
        this.startedAt = now;
        this.total = 0;
        this.attempts.clear();
      }
      const count = this.attempts.get(canonical) ?? 0;
      if (
        this.total >= this.policy.maxAttemptsGlobal ||
        count >= this.policy.maxAttemptsPerUsername ||
        (count === 0 && this.attempts.size >= this.policy.maxTrackedUsernames)
      )
        return false;
      this.attempts.set(canonical, count + 1);
      this.total++;
      return true;
    } catch {
      return false;
    }
  }
}
