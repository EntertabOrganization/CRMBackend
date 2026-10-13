import { NextRequest } from 'next/server';
import type { User } from './domain';
import { AppError, badRequest, unauthorized } from './errors';
import { verifyAccessToken } from './security';
import type { InMemoryStore } from './store';

export async function readRawBody(request: NextRequest, maxBytes?: number): Promise<string> {
  let text: string;
  if (maxBytes === undefined) text = await request.text();
  else {
    const tooLarge = () => new AppError('REQUEST_BODY_TOO_LARGE', 'Request body exceeds the allowed size.', 413);
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes) throw tooLarge();
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    text = Buffer.concat(chunks, size).toString('utf8');
  }
  return text;
}

export async function readJson<T>(request: NextRequest, maxBytes?: number): Promise<T> {
  const text = await readRawBody(request,maxBytes);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export async function requireUser(request: NextRequest, store: InMemoryStore): Promise<User> {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!token) throw unauthorized();
  const userId = await verifyAccessToken(token);
  const user = store.state.users.find((item) => item.id === userId && !item.isDeleted);
  if (!user) throw unauthorized();
  return user;
}

export function workspaceHeader(request: NextRequest) {
  return request.headers.get('x-workspace-id') ?? undefined;
}
