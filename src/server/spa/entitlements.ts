import { AppError } from '../errors';
import type { Tx } from '../process-platform/context';

/** Read the shared entitlement owner's grants, intersecting legacy Workspace configuration. */
export async function spaEntitlements(tx: Tx, workspaceId: string, enforce = true) {
  const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = workspace.settings as Record<string, unknown>;
  const configured = settings.entitlements;
  const result: Record<string, unknown> = configured && typeof configured === 'object' && !Array.isArray(configured) ? { ...configured } : {};
  const grants = await tx.commercialPackRecord.findMany({ where: { workspaceId, collection: 'entitlementGrants' } });
  for (const row of grants) {
    const grant = row.data as { workspaceId?: string; capability?: string; enabled?: boolean; limit?: unknown };
    if (grant.workspaceId !== workspaceId || !grant.capability?.startsWith('spa.')) continue;
    const key = grant.capability;
    if (key === 'spa.enabled' && grant.enabled === false) result.spa = false;
    if (key === 'spa.max_types' || key === 'spa.max_fields') {
      if (grant.enabled === false) result.spa = false;
      if (grant.limit !== null && grant.limit !== undefined) {
        if (typeof grant.limit !== 'number' || !Number.isSafeInteger(grant.limit) || grant.limit < 0) {
          if (enforce) throw new AppError('SPA_PLAN_LIMIT', 'Smart Process quota configuration is invalid.', 403);
          result.spa = false; continue;
        }
        const name = key === 'spa.max_types' ? 'maxSpaTypes' : 'maxSpaFields';
        result[name] = typeof result[name] === 'number' ? Math.min(result[name] as number, grant.limit) : grant.limit;
      }
    }
    if (key.startsWith('spa.capability.') && grant.enabled === false)
      result['capability.' + key.slice('spa.capability.'.length).toUpperCase()] = false;
  }
  for (const key of ['maxSpaTypes', 'maxSpaFields']) if (result[key] !== undefined &&
    (typeof result[key] !== 'number' || !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)) {
    if (enforce) throw new AppError('SPA_PLAN_LIMIT', 'Smart Process quota configuration is invalid.', 403);
    result.spa = false;
  }
  if (enforce && result.spa === false) throw new AppError('SPA_PLAN_LIMIT', 'Smart Processes are unavailable for this Workspace.', 403);
  return result;
}

export async function assertSpaSchemaEntitlements(tx: Tx, workspaceId: string, fields: number,
  capabilities: ReadonlyArray<{ key: string; enabled: boolean }> = []) {
  const limits = await spaEntitlements(tx, workspaceId);
  if (typeof limits.maxSpaFields === 'number' && fields > limits.maxSpaFields)
    throw new AppError('SPA_PLAN_LIMIT', 'Smart Process field limit reached.', 422);
  for (const capability of capabilities) if (capability.enabled && limits['capability.' + capability.key] === false)
    throw new AppError('SPA_PLAN_LIMIT', 'Smart Process capability is unavailable for this Workspace.', 403);
  return limits;
}
