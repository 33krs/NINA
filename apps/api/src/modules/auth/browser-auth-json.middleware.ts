import type { RequestHandler } from 'express';
import { Buffer, constants, isUtf8 } from 'node:buffer';
import { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export interface BrowserAuthJsonLimits {
  readonly maxBytes: number;
  readonly readTimeoutMs: number;
}

/** Inspect only syntax already accepted by JSON.parse; never parse a JSON grammar. */
function hasUniqueObjectKeys(text: string): boolean {
  const objects: Set<string>[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{') objects.push(new Set<string>());
    else if (character === '}') objects.pop();
    else if (character === '"') {
      const start = index;
      index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === '"') break;
        else index++;
      }
      const end = index + 1;
      let following = end;
      while (
        text[following] === ' ' ||
        text[following] === '\t' ||
        text[following] === '\r' ||
        text[following] === '\n'
      )
        following++;
      // In valid JSON only an object key string is followed by a colon.
      if (text[following] === ':') {
        const key = JSON.parse(text.slice(start, end)) as string;
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(key)) return false;
        keys.add(key);
      }
      // Consume this token's whitespace once, without skipping its next delimiter.
      index = following - 1;
    }
  }
  return true;
}

/** Unregistered: mount after no-store/admission, before any other body reader. */
export function createBrowserAuthJson(
  limits: BrowserAuthJsonLimits,
): RequestHandler {
  let maxBytes: number;
  let readTimeoutMs: number;
  try {
    ({ maxBytes, readTimeoutMs } = limits);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > constants.MAX_LENGTH ||
      !Number.isSafeInteger(readTimeoutMs) ||
      readTimeoutMs < 1 ||
      readTimeoutMs > 2 ** 31 - 1
    )
      throw new Error();
  } catch {
    throw new TypeError('Invalid browser JSON limits');
  }

  return (request, response, next) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let declaredLength: number | undefined;

    function cleanup(): boolean {
      if (settled) return false;
      settled = true;
      globalThis.clearTimeout(timer);
      chunks.length = 0;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', cancel);
      request.off('error', onError);
      request.off('close', cancel);
      response.off('finish', cancel);
      response.off('close', cancel);
      return true;
    }
    function cancel(): void {
      if (cleanup()) request.destroy();
    }
    function reject(status: number): void {
      if (!cleanup()) return;
      request.pause();
      if (
        response.destroyed ||
        response.writableEnded ||
        response.headersSent
      ) {
        request.destroy();
        return;
      }
      // Node closes this response's connection after flushing, without tail draining.
      response.shouldKeepAlive = false;
      response.statusCode = status;
      response.setHeader('Connection', 'close');
      response.setHeader('Content-Type', 'application/json');
      response.end('{"message":"Invalid request body"}');
    }
    function onError(): void {
      reject(400);
    }
    function onData(chunk: unknown): void {
      if (!Buffer.isBuffer(chunk)) return reject(400);
      if (chunk.length > maxBytes - received) return reject(413);
      received += chunk.length;
      chunks.push(chunk);
    }
    function onEnd(): void {
      if (declaredLength !== undefined && received !== declaredLength)
        return reject(400);
      let body: unknown;
      try {
        const bytes = Buffer.concat(chunks, received);
        if (!isUtf8(bytes)) return reject(400);
        const text = bytes.toString('utf8');
        // Keep the original text: native parsing alone loses overwritten keys.
        body = JSON.parse(text) as unknown;
        if (!hasUniqueObjectKeys(text)) return reject(400);
      } catch {
        return reject(400);
      }
      if (!cleanup()) return;
      request.body = body;
      next();
    }

    if (
      !(request instanceof IncomingMessage) ||
      Reflect.has(request, 'body') ||
      Readable.isDisturbed(request) ||
      request.destroyed ||
      request.readableEnded ||
      !request.readable ||
      request.readableEncoding !== null ||
      request.readableFlowing !== null ||
      request.listenerCount('data') !== 0 ||
      request.listenerCount('readable') !== 0
    )
      return reject(400);
    if (response.destroyed || response.writableEnded || response.headersSent)
      return cancel();

    let encoding: string | undefined;
    let length: string | undefined;
    const headers = request.rawHeaders;
    if (headers.length % 2 !== 0) return reject(400);
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index].toLowerCase();
      const value = headers[index + 1];
      if (name === 'content-encoding') {
        if (encoding !== undefined || value.toLowerCase() !== 'identity')
          return reject(415);
        encoding = value;
      } else if (name === 'content-length') {
        if (length !== undefined || !/^\d+$/.test(value)) return reject(400);
        length = value;
      }
    }
    if (length !== undefined) {
      if (BigInt(length) > BigInt(maxBytes)) return reject(413);
      declaredLength = Number(length);
    }

    response.once('finish', cancel);
    response.once('close', cancel);
    request.once('aborted', cancel);
    request.once('error', onError);
    request.once('close', cancel);
    request.once('end', onEnd);
    timer = globalThis.setTimeout(() => reject(408), readTimeoutMs);
    request.on('data', onData);
  };
}
