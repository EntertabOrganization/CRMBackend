import type { PrismaClient } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { resolvePrincipal, type Tx } from '../process-platform/context';
import type { ApiCredential } from './types';

/** Owning API credential authority for database-backed domain routers. */
export async function authenticateDomainCredential(db: PrismaClient | Tx, request: NextRequest, scope: string) {
  const raw = request.headers.get('authorization')!.slice('Bearer '.length);
  const hash = createHash('sha256').update(raw).digest('hex');
  const row = await db.commercialPackRecord.findFirst({ where: { collection: 'apiCredentials',
    data: { path: ['secretHash'], equals: hash } } });
  const credential = row?.data as ApiCredential | undefined;
  if (!row || !credential || row.workspaceId !== credential.workspaceId || credential.status !== 'ACTIVE' ||
    credential.expiresAt && new Date(credential.expiresAt) <= new Date())
    throw new AppError(credential?.status === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'UNAUTHENTICATED', 'API credential is invalid.', 401);
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes(scope))
    throw new AppError('API_SCOPE_DENIED', 'API credential scope is insufficient.', 403);
  if (request.headers.get('x-workspace-id') !== credential.workspaceId)
    throw new AppError('PERMISSION_DENIED', 'Credential Workspace cannot be overridden.', 403);
  // A credential never grants role, record, field, entitlement or lifecycle authority.
  const actor = await resolvePrincipal(db, credential.workspaceId, credential.principalId);
  await db.commercialPackRecord.update({ where: { id: row.id }, data: {
    data: { ...(row.data as Record<string, string>), lastUsedAt: new Date().toISOString() } } });
  return actor;
}
