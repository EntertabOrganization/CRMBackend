import type { NextRequest } from 'next/server';
import type { appContext as ApplicationContext } from './app-context';

import { AppError, badRequest } from './errors';
import { rateLimitUser } from './rate-limit';
import type { CrmRateLimit } from './rate-limit';
import { requireUser, workspaceHeader } from './request';

function context(): typeof ApplicationContext { return require('./app-context').appContext; }

/** Authenticated user + the workspace resolved from the server-checked header (never from the request body). */
export async function requireWorkspaceContext(request: NextRequest, rateLimit?: CrmRateLimit) {
  const authorization = request.headers.get('authorization') ?? '';
  const rawCredential = authorization.startsWith('Bearer trm_api_') ? authorization.slice('Bearer '.length) : null;
  if (rawCredential) {
    const requiredScope = apiScopeForOperation(request.method, request.nextUrl.pathname);
    if (!requiredScope && request.nextUrl.pathname !== '/api/v1/batch') {
      throw new AppError('API_SCOPE_DENIED', 'API credentials cannot access this endpoint.', 403);
    }
    const credential = context().intelligence.integrations.authenticateApi(rawCredential, requiredScope ?? undefined);
    const user = context().store.state.users.find((item) => item.id === credential.principalId && !item.isDeleted);
    if (!user) throw badRequest('CREDENTIAL_REVOKED', 'API credential principal is inactive.');
    const suppliedWorkspace = workspaceHeader(request);
    if (suppliedWorkspace && suppliedWorkspace !== credential.workspaceId) throw badRequest('WORKSPACE_CONTEXT_INVALID', 'Credential workspace cannot be overridden.');
    if (rateLimit) rateLimitUser(`api:${credential.id}`, rateLimit);
    return { user, workspaceId: credential.workspaceId, actor: context().access.actor(user, credential.workspaceId), credential };
  }
  const user = await requireUser(request, context().store);
  const workspaceId = workspaceHeader(request);
  if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
  if (rateLimit) rateLimitUser(user.id, rateLimit);
  return { user, workspaceId, actor: context().access.actor(user, workspaceId), credential: null };
}

/** Coarse API scope; normal RBAC and record scope are still enforced by each service. */
export function apiScopeForOperation(method: string, pathname: string) {
  const write = method.toUpperCase() !== 'GET';
  if (/^\/api\/v1\/crm\//.test(pathname)) return write ? 'crm.write' : 'crm.read';
  if (/^\/api\/v1\/data-quality(?:\/|$)/.test(pathname)) return write ? 'data_quality.write' : 'data_quality.read';
  if (/^\/api\/v1\/imports(?:\/|$)/.test(pathname)) return 'imports.manage';
  if (/^\/api\/v1\/exports(?:\/|$)/.test(pathname)) return 'exports.manage';
  if (/^\/api\/v1\/analytics(?:\/|$)/.test(pathname)) return 'analytics.read';
  if (/^\/api\/v1\/sales-intelligence(?:\/|$)/.test(pathname)) return write ? 'sales_intelligence.write' : 'sales_intelligence.read';
  if (/^\/api\/v1\/integrations\/webhook/.test(pathname)) return 'webhooks.manage';
  if (/^\/api\/v1\/integrations(?:\/|$)/.test(pathname)) return 'integrations.manage';
  if (/^\/api\/v1\/(?:tasks|task-checklists|task-checklist-items|task-time-entries|task-templates|projects|project-stages)(?:\/|$)/.test(pathname)) return write ? 'tasks.write' : 'tasks.read';
  return null;
}

export function requireCredentialScope(credential: { scopes: string[] } | null, scope: string | null) {
  if (credential && (!scope || !credential.scopes.includes(scope))) {
    throw new AppError('API_SCOPE_DENIED', 'API credential scope is insufficient.', 403);
  }
}

export function idempotencyKeyOf(request: NextRequest) {
  return request.headers.get('idempotency-key') ?? undefined;
}

const ENTITY_ALIASES: Record<string, string> = {
  lead: 'LEAD',
  leads: 'LEAD',
  contact: 'CONTACT',
  contacts: 'CONTACT',
  company: 'COMPANY',
  companies: 'COMPANY',
  deal: 'DEAL',
  deals: 'DEAL',
};

/** Accepts singular or plural route segments (deal/deals) and rejects everything else. */
export function entityTypeFromParam(raw: string) {
  const entityType = ENTITY_ALIASES[raw.toLowerCase()];
  if (!entityType) throw badRequest('ENTITY_TYPE_NOT_FIELD_CAPABLE', `${raw} is not a supported CRM entity type.`);
  return entityType;
}

/** Field-schema routes also cover Activities, which register with the field engine like any other entity. */
export function fieldEntityTypeFromParam(raw: string) {
  const lower = raw.toLowerCase();
  if (lower === 'activity' || lower === 'activities') return 'ACTIVITY';
  return entityTypeFromParam(raw);
}
