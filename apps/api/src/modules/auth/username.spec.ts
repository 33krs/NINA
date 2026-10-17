import { describe, expect, it } from '@jest/globals';
import { canonicalizeUsername } from './username';

describe('username canonicalization', () => {
  it('trims outer whitespace and lowercases ASCII without changing allowed punctuation', () => {
    expect(canonicalizeUsername('  Alice.User_1-2 \n')).toBe('alice.user_1-2');
  });

  it('accepts the documented minimum and maximum canonical lengths', () => {
    expect(canonicalizeUsername('Ab1')).toBe('ab1');
    expect(canonicalizeUsername(`A${'b'.repeat(31)}`)).toBe(
      `a${'b'.repeat(31)}`,
    );
  });

  it.each([
    ['non-string', 42],
    ['null', null],
    ['object', {}],
    ['too short', 'ab'],
    ['too long after trim', `a${'b'.repeat(32)}`],
    ['too long before trim', ` ${'a'.repeat(128)} `],
    ['leading punctuation', '_alice'],
    ['internal whitespace', 'alice smith'],
    ['unsupported punctuation', 'alice+smith'],
    ['Unicode confusable', 'аlice'],
    ['Unicode compatibility fold', 'Kevin'],
    ['Unicode outer whitespace', '\u2000alice'],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalizeUsername(value)).toThrow('Invalid username');
  });
});
