import { describe, expect, it } from '@jest/globals';
import {
  BrowserLoginAttempts,
  type BrowserLoginAttemptPolicy,
} from './browser-login-attempts';

function policy() {
  return {
    windowMs: 100,
    maxAttemptsPerUsername: 2,
    maxAttemptsGlobal: 3,
    maxTrackedUsernames: 2,
  };
}

function fixture(overrides: Partial<BrowserLoginAttemptPolicy> = {}) {
  let now = 10;
  const gate = new BrowserLoginAttempts(
    { ...policy(), ...overrides },
    () => now,
  );
  return { gate, time: (value: number) => (now = value) };
}

describe('count-all fixed-window login admission', () => {
  it.each(Object.keys(policy()))(
    'requires a bounded positive integer %s',
    (key) => {
      for (const value of [
        undefined,
        null,
        '1',
        0,
        -1,
        0.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(
          () =>
            new BrowserLoginAttempts({
              ...policy(),
              [key]: value,
            } as BrowserLoginAttemptPolicy),
        ).toThrow();
      }
    },
  );

  it.each([undefined, null, {}])('rejects a missing policy: %s', (input) => {
    expect(
      () => new BrowserLoginAttempts(input as BrowserLoginAttemptPolicy),
    ).toThrow();
  });

  it('accepts the full positive safe-integer policy range', () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER]) {
      const gate = new BrowserLoginAttempts(
        {
          windowMs: value,
          maxAttemptsPerUsername: value,
          maxAttemptsGlobal: value,
          maxTrackedUsernames: value,
        },
        () => 0,
      );
      expect(gate.reserve('learner')).toBe(true);
    }
  });

  it('copies every policy field instead of retaining caller configuration', () => {
    const settings = policy();
    let now = 0;
    const gate = new BrowserLoginAttempts(settings, () => now);
    settings.windowMs = 1;
    settings.maxAttemptsPerUsername = 20;
    settings.maxAttemptsGlobal = 20;
    settings.maxTrackedUsernames = 20;
    expect(gate.reserve('first')).toBe(true);
    expect(gate.reserve('first')).toBe(true);
    now = 1;
    expect(gate.reserve('first')).toBe(false);
    expect(gate.reserve('second')).toBe(true);
    expect(gate.reserve('second')).toBe(false);
    expect(gate.reserve('third')).toBe(false);
    now = 100;
    expect(gate.reserve('third')).toBe(true);
  });

  it('copies the tracked-name capacity independently of global exhaustion', () => {
    const settings = { ...policy(), maxTrackedUsernames: 1 };
    const gate = new BrowserLoginAttempts(settings, () => 0);
    settings.maxTrackedUsernames = 10;
    expect(gate.reserve('first')).toBe(true);
    expect(gate.reserve('second')).toBe(false);
    expect(gate.reserve('first')).toBe(true);
  });

  it('shares ASCII trim/lowercase aliases, including names unknown to any database', () => {
    const { gate } = fixture();
    expect(gate.reserve(' Unknown.User ')).toBe(true);
    expect(gate.reserve('\tUNKNOWN.USER\r\n')).toBe(true);
    expect(gate.reserve('unknown.user')).toBe(false);
    expect(gate.reserve('another')).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    'ab',
    'éclair',
    'user/name',
    '.learner',
    'a'.repeat(129),
    {},
  ])(
    'denies invalid username input without occupying a bucket: %s',
    (username) => {
      const { gate } = fixture({
        maxAttemptsGlobal: 1,
        maxTrackedUsernames: 1,
      });
      expect(gate.reserve(username)).toBe(false);
      expect(gate.reserve('learner')).toBe(true);
    },
  );

  it('bounds the global total across different usernames', () => {
    const { gate } = fixture({ maxTrackedUsernames: 10 });
    expect(gate.reserve('first')).toBe(true);
    expect(gate.reserve('second')).toBe(true);
    expect(gate.reserve('third')).toBe(true);
    expect(gate.reserve('fourth')).toBe(false);
    expect(gate.reserve('first')).toBe(false);
  });

  it('rejects new names at capacity without evicting or charging existing buckets', () => {
    const { gate } = fixture({ maxAttemptsGlobal: 10, maxTrackedUsernames: 1 });
    expect(gate.reserve('first')).toBe(true);
    for (let index = 0; index < 20; index++)
      expect(gate.reserve(`unknown-${index}`)).toBe(false);
    expect(gate.reserve('FIRST')).toBe(true);
    expect(gate.reserve('first')).toBe(false);
  });

  it('resets all state exactly at the shared boundary; denials never extend it', () => {
    const { gate, time } = fixture({
      maxAttemptsGlobal: 1,
      maxTrackedUsernames: 1,
    });
    expect(gate.reserve('first')).toBe(true);
    time(109.5);
    expect(gate.reserve('second')).toBe(false);
    expect(gate.reserve('first')).toBe(false);
    time(110);
    expect(gate.reserve('second')).toBe(true);
    expect(gate.reserve('first')).toBe(false);
    time(210);
    expect(gate.reserve('first')).toBe(true);
  });

  it('uses one shared window rather than extending each username separately', () => {
    const { gate, time } = fixture();
    expect(gate.reserve('first')).toBe(true);
    time(109);
    expect(gate.reserve('second')).toBe(true);
    expect(gate.reserve('second')).toBe(true);
    time(110);
    expect(gate.reserve('second')).toBe(true);
    expect(gate.reserve('first')).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, -1, 9])(
    'denies invalid or backward clock %s without resetting state',
    (invalid) => {
      const { gate, time } = fixture({ maxAttemptsGlobal: 1 });
      expect(gate.reserve('first')).toBe(true);
      time(invalid);
      expect(gate.reserve('second')).toBe(false);
      time(109);
      expect(gate.reserve('second')).toBe(false);
      time(110);
      expect(gate.reserve('second')).toBe(true);
    },
  );

  it('compares against the latest observation, not just window start', () => {
    const { gate, time } = fixture();
    expect(gate.reserve('first')).toBe(true);
    time(50);
    expect(gate.reserve('second')).toBe(true);
    time(49);
    expect(gate.reserve('first')).toBe(false);
    time(50);
    expect(gate.reserve('first')).toBe(true);
  });

  it('contains a throwing clock and does not start its window on failure', () => {
    let throws = true;
    const gate = new BrowserLoginAttempts(policy(), () => {
      if (throws) throw new Error('Synthetic clock failure');
      return 10;
    });
    expect(gate.reserve('first')).toBe(false);
    throws = false;
    expect(gate.reserve('first')).toBe(true);
  });

  it('keeps distinct handler gates independent without a production reset API', () => {
    const first = fixture({ maxAttemptsGlobal: 1 }).gate;
    const second = fixture({ maxAttemptsGlobal: 1 }).gate;
    expect(first.reserve('learner')).toBe(true);
    expect(first.reserve('learner')).toBe(false);
    expect(second.reserve('learner')).toBe(true);
  });
});
