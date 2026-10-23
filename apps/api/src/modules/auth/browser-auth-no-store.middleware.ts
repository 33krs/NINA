import type { NextFunction, Request, Response } from 'express';

/** Unregistered middleware; install before parsers when auth routes are activated. */
export function browserAuthNoStore(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader('Cache-Control', 'no-store');
  next();
}
