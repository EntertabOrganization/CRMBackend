import { resetAppContextForTests } from '@/src/server/app-context';
import type { PermissionScope, User } from '@/src/server/domain';
import type { ActorContext } from '@/src/server/access-service';
import { InMemoryFilePort } from '@/src/server/ports';

export type FullApp = ReturnType<typeof resetAppContextForTests>;

let counter = 0;

/** A brand-new application context (fresh in-memory store, all modules wired) with one verified workspace owner. */
export async function fullApp() {
  const app = resetAppContextForTests();
  const files = new InMemoryFilePort();
  app.setFilePort(files);
  const owner = await verified(app, 'owner');
  return { app, files, ...owner };
}

export async function verified(app: FullApp, label: string) {
  counter += 1;
  const email = `${label}-${counter}@example.com`;
  const signup = await app.auth.signup({ firstName: label, lastName: `User${counter}`, email, password: 'Password1' });
  const session = await app.auth.verifyEmail(signup.verificationToken);
  const user = app.store.state.users.find((candidate) => candidate.email === email)!;
  return { user, workspace: session.workspace!, session };
}

/** Another workspace owner in the same application (used for cross-tenant tests). */
export async function otherTenant(app: FullApp, label = 'tenant') {
  return verified(app, label);
}

export function actorOf(app: FullApp, user: User, workspaceId: string): ActorContext {
  return app.access.actor(user, workspaceId);
}

/**
 * Adds a workspace member holding a custom role. `permissions` are `[key, scope]` pairs; the role gets exactly those.
 * Returns the invited-and-accepted user.
 */
export async function addMember(
  app: FullApp,
  owner: User,
  workspaceId: string,
  label: string,
  permissions: Array<[string, PermissionScope]>,
) {
  counter += 1;
  const role = app.roles.create(owner, workspaceId, { name: `${label} role ${counter}` });
  app.roles.replacePermissions(
    owner,
    workspaceId,
    role.id,
    permissions.map(([permissionId, scope]) => ({ permissionId, scope })),
  );
  const email = `${label}-${counter}@example.com`;
  const invitation = await app.users.invite(owner, { workspaceId, email, roleId: role.id });
  const signup = await app.auth.signup({ firstName: label, lastName: `Member${counter}`, email, password: 'Password1' });
  await app.auth.verifyEmail(signup.verificationToken);
  const user = app.store.state.users.find((candidate) => candidate.email === email)!;
  await app.users.acceptInvitation(user, invitation.invitationToken);
  return { user, role };
}

/** Common permission bundles for readability. */
export const CRM_READ: Array<[string, PermissionScope]> = [
  ['crm.lead.read', 'WORKSPACE'],
  ['crm.contact.read', 'WORKSPACE'],
  ['crm.company.read', 'WORKSPACE'],
  ['crm.deal.read', 'WORKSPACE'],
];
export const CRM_READ_UPDATE: Array<[string, PermissionScope]> = [
  ...CRM_READ,
  ['crm.lead.update', 'WORKSPACE'],
  ['crm.contact.update', 'WORKSPACE'],
  ['crm.company.update', 'WORKSPACE'],
  ['crm.deal.update', 'WORKSPACE'],
];
export const ACTIVITY_BASIC: Array<[string, PermissionScope]> = [
  ['activity.create', 'WORKSPACE'],
  ['activity.read', 'WORKSPACE'],
  ['activity.update', 'WORKSPACE'],
  ['activity.complete', 'WORKSPACE'],
  ['timeline.read', 'WORKSPACE'],
  ['timeline.comment', 'WORKSPACE'],
];

export function iso(offsetMs: number, from = Date.now()) {
  return new Date(from + offsetMs).toISOString();
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Drains outbox events into Timeline entries (what the request wrapper does after every request). */
export function project(app: FullApp) {
  return app.timeline.projectPending();
}

export async function expectAppError(promise: unknown, code: string, status?: number) {
  try {
    await (typeof promise === 'function' ? (promise as () => unknown)() : promise);
  } catch (error) {
    const appError = error as { code?: string; status?: number; message?: string };
    if (appError.code !== code || (status !== undefined && appError.status !== status)) {
      throw new Error(`Expected AppError ${code}${status ? ` (${status})` : ''}, got ${appError.code} (${appError.status}): ${appError.message}`);
    }
    return appError as { code: string; status: number; message: string; details: any };
  }
  throw new Error(`Expected AppError ${code}, but the operation succeeded.`);
}
