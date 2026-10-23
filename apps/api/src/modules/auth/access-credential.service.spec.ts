import { Buffer } from 'node:buffer';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { generateKeyPairSync, sign, createSecretKey } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import {
  AccessCredentialService,
  type AccessCredentialConfig,
} from './access-credential.service';
import type { SessionService } from './session.service';

const SID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const NOW = 1800000000;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const current = {
  id: OWNER,
  username: 'current.name',
  role: 'STUDENT' as const,
  authVersion: 2,
};
const config: AccessCredentialConfig = {
  ...keys,
  issuer: 'nina-test',
  audience: 'nina-access-test',
  lifetimeSeconds: 60,
};

function signed(): string {
  return jwt.sign(
    { sub: OWNER, sid: SID, authVersion: 2, iat: NOW, exp: NOW + 60 },
    keys.privateKey,
    {
      algorithm: 'RS256',
      issuer: config.issuer,
      audience: config.audience,
      header: { alg: 'RS256', typ: 'nina-access+jwt' },
    },
  );
}

// Adversarial fixtures intentionally bypass JWT signing-input validation.
function crafted(
  payload: unknown,
  header: unknown = { alg: 'RS256', typ: 'nina-access+jwt' },
  key = keys.privateKey,
): string {
  const encoded = [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), key).toString('base64url')}`;
}

function claims(): Record<string, unknown> {
  return {
    sub: OWNER,
    sid: SID,
    authVersion: 2,
    iat: NOW,
    exp: NOW + 60,
    iss: config.issuer,
    aud: config.audience,
  };
}

describe('AccessCredentialService (internal only)', () => {
  let validate: jest.Mock<SessionService['validate']>;
  let service: AccessCredentialService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW * 1000);
    validate = jest.fn<SessionService['validate']>().mockResolvedValue(current);
    service = new AccessCredentialService(
      { validate } as unknown as SessionService,
      config,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('issues a minimal signed credential only after online validation', async () => {
    const token = await service.issue(SID, OWNER, 2);
    expect(token).toEqual(expect.any(String));
    expect(validate).toHaveBeenCalledWith(SID, OWNER, 2);
    const decoded = jwt.verify(token!, keys.publicKey, {
      algorithms: ['RS256'],
    });
    expect(decoded).toEqual({
      sub: OWNER,
      sid: SID,
      authVersion: 2,
      iat: NOW,
      exp: NOW + 60,
      iss: config.issuer,
      aud: config.audience,
    });
  });

  it('returns the current online identity rather than token identity claims', async () => {
    expect(await service.verify(signed())).toEqual(current);
    expect(validate).toHaveBeenCalledWith(SID, OWNER, 2);
  });

  it.each([1, 900])(
    'supports explicit lifetime %i without changing backend session policy',
    async (lifetimeSeconds) => {
      service = new AccessCredentialService(
        { validate } as unknown as SessionService,
        { ...config, lifetimeSeconds },
      );
      const token = await service.issue(SID, OWNER, 2);
      expect(await service.verify(token)).toEqual(current);
      expect((jwt.decode(token!) as jwt.JwtPayload).exp).toBe(
        NOW + lifetimeSeconds,
      );
    },
  );

  it('copies constructor policy instead of retaining a mutable configuration object', async () => {
    const mutable = { ...config };
    service = new AccessCredentialService(
      { validate } as unknown as SessionService,
      mutable,
    );
    Object.assign(mutable, {
      issuer: 'changed',
      audience: 'changed',
      lifetimeSeconds: 900,
      ...other,
    });
    expect(await service.verify(await service.issue(SID, OWNER, 2))).toEqual(
      current,
    );
    expect(await service.verify(signed())).toEqual(current);
  });

  it('waits for successful online validation before issuing', async () => {
    let release!: (value: typeof current | null) => void;
    validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.issue(SID, OWNER, 2);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(null);
    expect(await pending).toBeNull();
  });

  it.each([null, new Error('private infrastructure detail')])(
    'denies both operations on online failure %p',
    async (failure) => {
      if (failure instanceof Error) validate.mockRejectedValue(failure);
      else validate.mockResolvedValue(null);
      expect(await service.issue(SID, OWNER, 2)).toBeNull();
      expect(await service.verify(signed())).toBeNull();
      expect(validate).toHaveBeenCalledTimes(2);
    },
  );

  it('returns updated identity on each verification, without caching account authorization', async () => {
    const token = signed();
    expect(await service.verify(token)).toEqual(current);
    const changed = {
      ...current,
      username: 'renamed',
      role: 'INSTRUCTOR' as const,
    };
    validate.mockResolvedValueOnce(changed).mockResolvedValueOnce(null);
    expect(await service.verify(token)).toEqual(changed);
    expect(await service.verify(token)).toBeNull();
  });

  it('denies expiry reached while awaiting the session check', async () => {
    validate.mockImplementationOnce(async () => {
      jest.setSystemTime((NOW + 60) * 1000);
      return current;
    });
    expect(await service.verify(signed())).toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('denies clock rollback past issuance during the session check', async () => {
    validate.mockImplementationOnce(async () => {
      jest.setSystemTime((NOW - 1) * 1000);
      return current;
    });
    expect(await service.verify(signed())).toBeNull();
  });

  it('accepts immediately before expiry but denies the exact boundary before online work', async () => {
    const token = signed();
    jest.setSystemTime((NOW + 60) * 1000 - 1);
    expect(await service.verify(token)).toEqual(current);
    validate.mockClear();
    jest.setSystemTime((NOW + 60) * 1000);
    expect(await service.verify(token)).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    1,
    {},
    '',
    'x'.repeat(8193),
    'a.b.c',
    ' a.b.c',
    'a.b',
    'a.b.c.d',
  ])(
    'rejects malformed or bounded input case %# without online work',
    async (token) => {
      expect(await service.verify(token)).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, OWNER, 2],
    [SID, 'invalid', 2],
    [SID, OWNER, -1],
    [SID, OWNER, 2147483648],
    [SID, OWNER, 0.5],
    [SID, OWNER, '2'],
  ])(
    'rejects invalid issuance identifiers/version before online work',
    async (sid, owner, version) => {
      expect(await service.issue(sid, owner, version)).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each(['sub', 'sid', 'authVersion', 'iat', 'exp', 'iss', 'aud'])(
    'requires claim %s',
    async (name) => {
      const payload = claims();
      delete payload[name];
      expect(await service.verify(crafted(payload))).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['sub', 'invalid'],
    ['sid', 1],
    ['authVersion', '2'],
    ['authVersion', -1],
    ['authVersion', 2147483648],
    ['authVersion', 0.5],
    ['iat', 'now'],
    ['iat', NOW + 1],
    ['iat', -1],
    ['iat', NOW - 1],
    ['iat', NOW + 0.5],
    ['exp', 'later'],
    ['exp', NOW],
    ['exp', NOW - 1],
    ['exp', NOW + 61],
    ['exp', NOW + 1.5],
    ['exp', Number.MAX_SAFE_INTEGER + 1],
    ['iss', 'other'],
    ['aud', 'other'],
    ['aud', [config.audience]],
    ['role', 'ADMIN'],
    ['nbf', NOW],
    ['refresh', 'secret'],
  ])(
    'denies invalid/extra claim %s=%p before online validation',
    async (name, value) => {
      expect(
        await service.verify(crafted({ ...claims(), [name]: value })),
      ).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { alg: 'RS256' },
    { alg: 'RS256', typ: 'JWT' },
    { alg: 'RS256', typ: 'nina-refresh+jwt' },
    { alg: 'RS256', typ: 'nina-access+jwt', kid: 'remote-key' },
    {
      alg: 'RS256',
      typ: 'nina-access+jwt',
      jku: 'https://invalid.example/key',
    },
    { alg: 'RS256', typ: 'nina-access+jwt', crit: ['extra'] },
    { alg: 'RS512', typ: 'nina-access+jwt' },
    { alg: 'none', typ: 'nina-access+jwt' },
  ])(
    'denies unexpected protected header %p before online validation',
    async (header) => {
      expect(await service.verify(crafted(claims(), header))).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it('rejects wrong signature, tampering, HMAC confusion and unsigned credentials before online work', async () => {
    const valid = signed();
    const parts = valid.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...claims(), authVersion: 3 }),
    ).toString('base64url');
    const hmac = jwt.sign(
      claims(),
      keys.publicKey.export({ type: 'spki', format: 'pem' }),
      { algorithm: 'HS256' },
    );
    for (const token of [
      crafted(claims(), undefined, other.privateKey),
      `${parts[0]}.${tampered}.${parts[2]}`,
      hmac,
      `${parts[0]}.${parts[1]}.`,
    ]) {
      expect(await service.verify(token)).toBeNull();
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([null, 'payload', [], 42])(
    'denies nonobject payload %p',
    async (payload) => {
      expect(await service.verify(crafted(payload))).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { lifetimeSeconds: undefined },
    { lifetimeSeconds: 0 },
    { lifetimeSeconds: 901 },
    { lifetimeSeconds: 1.5 },
    { lifetimeSeconds: NaN },
    { lifetimeSeconds: Infinity },
    { issuer: '' },
    { audience: ' ' },
    { issuer: 'x'.repeat(257) },
    { audience: undefined },
    { privateKey: keys.publicKey },
    { publicKey: keys.privateKey },
    { publicKey: other.publicKey },
    { ...weak },
    { ...ec },
    { privateKey: createSecretKey(Buffer.alloc(32)) },
    { publicKey: 'not a key' },
  ])(
    'rejects invalid local configuration case %# with generic diagnostics',
    (override) => {
      expect(
        () =>
          new AccessCredentialService(
            { validate } as unknown as SessionService,
            { ...config, ...override } as AccessCredentialConfig,
          ),
      ).toThrow('Invalid access credential configuration');
      expect(validate).not.toHaveBeenCalled();
    },
  );
});
