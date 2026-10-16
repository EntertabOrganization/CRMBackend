import type { Principal, Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';

/**
 * Live authorization for derived views (search hits, favorites, recents, notification previews, realtime hints).
 * Each owning module registers a resolver that answers "which of these ids may this principal read NOW".
 * Unknown types are never visible (fail closed). Derived rows are never an authority.
 */
export type AccessResolver = (tx: Tx, actor: Principal, ids: string[]) => Promise<Set<string>>;
const resolvers = new Map<string, AccessResolver>();
export function registerAccess(entityType: string, resolver: AccessResolver) { resolvers.set(entityType, resolver); }
export function hasResolver(entityType: string) { return resolvers.has(entityType); }

export async function visibleIds(tx: Tx, actor: Principal, entityType: string, ids: string[]): Promise<Set<string>> {
  const resolver = resolvers.get(entityType);
  if (!resolver || !ids.length) return new Set();
  try { return await resolver(tx, actor, [...new Set(ids)]); } catch { return new Set(); }
}
/** Filters mixed references, keeping input order. */
export async function filterVisible<T extends { entityType: string; entityId: string }>(tx: Tx, actor: Principal, rows: T[]) {
  const byType = new Map<string, string[]>();
  for (const r of rows) byType.set(r.entityType, [...(byType.get(r.entityType) ?? []), r.entityId]);
  const allowed = new Map<string, Set<string>>();
  for (const [type, ids] of byType) allowed.set(type, await visibleIds(tx, actor, type, ids));
  return rows.filter(r => allowed.get(r.entityType)?.has(r.entityId));
}

const has = (actor: Principal, permission: string) => actor.grants.has(permission);

// ------------------------------------------------------------------ built-in resolvers for existing domains
registerAccess('crm.contact', async (tx, actor, ids) => {
  if (!has(actor, 'crm.contact.read')) return new Set();
  const rows = await tx.crmContact.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids }, isDeleted: false }, select: { id: true, responsibleUserId: true } });
  const out = new Set<string>(); for (const r of rows) if (await ownerVisible(tx, actor, r.responsibleUserId, 'crm.contact.read')) out.add(r.id);
  return out;
});
registerAccess('task', async (tx, actor, ids) => {
  if (!has(actor, 'task.read')) return new Set();
  const rows = await tx.task.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids }, isDeleted: false }, select: { id: true, createdByUserId: true, responsibleUserId: true } });
  if (actor.grants.get('task.read') === 'WORKSPACE') return new Set(rows.map(r => r.id));
  const members = await tx.taskMember.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, taskId: { in: ids } }, select: { taskId: true } });
  return new Set(rows.filter(r => r.createdByUserId === actor.userId || r.responsibleUserId === actor.userId || members.some(m => m.taskId === r.id)).map(r => r.id));
});
registerAccess('drive.file', async (tx, actor, ids) => {
  const { cleanFile } = await import('../suite/files-port');
  const out = new Set<string>(); for (const id of ids) try { await cleanFile(tx, actor, id); out.add(id); } catch { /* denied or quarantined */ }
  return out;
});
registerAccess('hr.employee', async (tx, actor, ids) => {
  const { readableEmployee } = await import('../hr/support');
  const out = new Set<string>(); for (const id of ids) try { await readableEmployee(tx, actor, id); out.add(id); } catch { /* concealed */ }
  return out;
});
registerAccess('site', async (tx, actor, ids) => {
  const { loadSite } = await import('../sites/support');
  const out = new Set<string>(); for (const id of ids) try { await loadSite(tx, actor, id, 'sites.site.read'); out.add(id); } catch { /* concealed */ }
  return out;
});
registerAccess('marketing.campaign', async (tx, actor, ids) => {
  const { loadCampaign } = await import('../marketing/support');
  const out = new Set<string>(); for (const id of ids) try { await loadCampaign(tx, actor, id, 'marketing.campaign.read'); out.add(id); } catch { /* concealed */ }
  return out;
});
