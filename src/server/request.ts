import { NextRequest } from 'next/server';
import type { User } from './domain';
import { badRequest, unauthorized } from './errors';
import { verifyAccessToken } from './security';
import type { InMemoryStore } from './store';

export async function readJson<T>(request: NextRequest): Promise<T> {
  const text = await request.text();
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
