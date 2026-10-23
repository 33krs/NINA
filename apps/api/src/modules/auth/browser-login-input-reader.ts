import { Buffer } from 'node:buffer';

export interface BrowserLoginInput {
  readonly username: string;
  readonly password: string;
}

/** Internal transport extraction only; accepted input is not authenticated. */
export class BrowserLoginInputReader {
  read(body: unknown): BrowserLoginInput | null {
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const prototype: unknown = Object.getPrototypeOf(body);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const keys = Reflect.ownKeys(body);
      if (
        keys.length !== 2 ||
        !keys.includes('username') ||
        !keys.includes('password')
      )
        return null;

      // Read data descriptors, never credential accessors or proxy get traps.
      const usernameField = Object.getOwnPropertyDescriptor(body, 'username');
      const passwordField = Object.getOwnPropertyDescriptor(body, 'password');
      if (
        !usernameField?.enumerable ||
        !passwordField?.enumerable ||
        !('value' in usernameField) ||
        !('value' in passwordField)
      )
        return null;
      const username: unknown = usernameField.value;
      const password: unknown = passwordField.value;
      if (
        typeof username !== 'string' ||
        username.length > 128 ||
        typeof password !== 'string' ||
        password.length > 1024 ||
        Buffer.byteLength(password, 'utf8') > 1024
      )
        return null;

      return Object.freeze({ username, password });
    } catch {
      // Reflective operations on unknown objects may throw; return no input.
      return null;
    }
  }
}
