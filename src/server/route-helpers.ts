import type { NextRequest } from 'next/server';
import { appContext } from './app-context';
import { badRequest } from './errors';
import { rateLimitUser } from './rate-limit';
import type { CrmRateLimit } from './rate-limit';
import { requireUser, workspaceHeader } from './request';

/** Authenticated user + the workspace resolved from the server-checked header (never from the request body). */
export async function requireWorkspaceContext(request: NextRequest, rateLimit?: CrmRateLimit) {
  const user = await requireUser(request, appContext.store);
  const workspaceId = workspaceHeader(request);
  if (!workspaceId) throw badRequest('WORKSPACE_REQUIRED', 'X-Workspace-Id is required.');
  if (rateLimit) rateLimitUser(user.id, rateLimit);
  return { user, workspaceId, actor: appContext.access.actor(user, workspaceId) };
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
