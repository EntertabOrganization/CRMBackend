/**
 * Service-level harness for the collaboration contract specs: a fresh in-memory application context with every module
 * wired (the same services the HTTP routes call), plus helpers to create members with exact permission sets.
 */
import { Body } from '@/src/server/collab/support';
import type { PermissionScope } from '@/src/server/domain';
import { addMember, fullApp, otherTenant } from '@/tests/support/domain';

export const b = (raw: Record<string, unknown> = {}) => new Body(raw);

export const perms = (scope: PermissionScope, ...keys: string[]): Array<[string, PermissionScope]> => keys.map((key) => [key, scope]);

export async function collabApp() {
  const base = await fullApp();
  const { app } = base;
  const owner = app.access.actor(base.user, base.workspace.id);
  const memberActor = async (label: string, permissions: Array<[string, PermissionScope]>) => {
    const created = await addMember(app, base.user, base.workspace.id, label, permissions);
    return app.access.actor(created.user, base.workspace.id);
  };
  const foreignActor = async (label = 'foreign') => {
    const tenant = await otherTenant(app, label);
    return app.access.actor(tenant.user, tenant.workspace.id);
  };
  // `state` is a live getter: some platform services (invitations, roles) replace `store.state` wholesale.
  return {
    ...base,
    owner,
    memberActor,
    foreignActor,
    collab: app.collab,
    get state() {
      return app.store.state;
    },
  };
}

/** Optional modules are looked up dynamically so a missing owning module reports an explicit BLOCKED reason. */
export function requireModule<T>(collab: unknown, name: string, owner: string): T {
  const module = (collab as Record<string, unknown>)[name];
  if (!module) throw new Error(`BLOCKED: this scenario needs the ${owner} module (collab.${name}), which is not implemented yet.`);
  return module as T;
}
