const MAX_USERNAME_INPUT_LENGTH = 128;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const ASCII_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const CANONICAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/** Return the unique stored form for a bounded, ASCII username input. */
export function canonicalizeUsername(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_USERNAME_INPUT_LENGTH ||
    !isAscii(value)
  ) {
    throw new Error('Invalid username');
  }

  const trimmed = value.trim();
  if (!ASCII_USERNAME_PATTERN.test(trimmed))
    throw new Error('Invalid username');

  const canonical = trimmed.toLowerCase();
  if (
    canonical.length < MIN_USERNAME_LENGTH ||
    canonical.length > MAX_USERNAME_LENGTH ||
    !CANONICAL_USERNAME_PATTERN.test(canonical)
  ) {
    throw new Error('Invalid username');
  }

  return canonical;
}
