/**
 * Shared HTTP harness for the collaboration contract tests. Requests go through the real Next route handlers, the real
 * transactional request wrapper and a throwaway PostgreSQL database (entertabcrm_test), exactly like tests/api-endpoints.
 */
import type { PermissionScope } from '@/src/server/domain';
import { api, prepareTestDatabase } from '@/tests/support/api';
import type { ApiResult, Method } from '@/tests/support/api';

export type Session = { token: string; userId: string; workspaceId: string; email: string };

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let counter = 0;

/** Prepares the test database once per Jest process for all collaboration E2E files (each test uses its own tenants). */
export async function prepareCollabDatabase() {
  if (process.env.COLLAB_TEST_DB_URL && process.env.DATABASE_URL === process.env.COLLAB_TEST_DB_URL && process.env.COLLAB_TEST_DB_READY === '1') return;
  await prepareTestDatabase();
  process.env.COLLAB_TEST_DB_URL = process.env.DATABASE_URL;
  process.env.COLLAB_TEST_DB_READY = '1';
}

export async function disconnect() {
  const { prisma } = await import('@/src/server/prisma-client');
  await prisma.$disconnect();
}

export async function db() {
  const { prisma } = await import('@/src/server/prisma-client');
  return prisma;
}

/** Signs up + verifies a user over HTTP; the user owns a fresh Workspace (its own tenant). */
export async function register(label: string): Promise<Session> {
  counter += 1;
  const email = `collab-${label}-${RUN}-${counter}@example.com`;
  const signup = await api('POST', '/api/v1/auth/signup', { body: { firstName: 'Collab', lastName: label, email, password: 'Password1' } });
  if (signup.status !== 200) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
  const verified = await api('POST', '/api/v1/auth/verify-email', { body: { token: signup.data.verificationToken } });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  return { token: verified.data.accessToken, userId: verified.data.user.id, workspaceId: verified.data.workspace.id, email };
}

/**
 * Adds a member with a custom role holding exactly `permissions` to the owner's Workspace. There is no HTTP endpoint to
 * accept an invitation, so the role/invite/accept steps run in one real transactional state unit (persisted to Postgres).
 */
export async function member(owner: Session, label: string, permissions: Array<[string, PermissionScope]>): Promise<Session> {
  const session = await register(label);
  const { runStateUnit } = await import('@/src/server/response');
  const { appContext } = await import('@/src/server/app-context');
  await runStateUnit(async () => {
    const ownerUser = appContext.store.state.users.find((row) => row.id === owner.userId)!;
    const role = appContext.roles.create(ownerUser, owner.workspaceId, { name: `${label} role ${RUN}-${counter}` });
    const ids = new Map(appContext.store.state.permissions.map((row) => [row.key, row.id]));
    appContext.roles.replacePermissions(ownerUser, owner.workspaceId, role.id, permissions.map(([key, scope]) => {
      const permissionId = ids.get(key);
      if (!permissionId) throw new Error(`Unknown permission ${key}`);
      return { permissionId, scope };
    }));
    const invitation = await appContext.users.invite(ownerUser, { workspaceId: owner.workspaceId, email: session.email, roleId: role.id });
    const user = appContext.store.state.users.find((row) => row.id === session.userId)!;
    appContext.users.acceptInvitation(user, invitation.invitationToken);
  });
  return { ...session, workspaceId: owner.workspaceId };
}

export function as(session: Session, extra: { body?: unknown; params?: Record<string, string | string[]>; query?: Record<string, string>; headers?: Record<string, string>; workspaceId?: string } = {}) {
  return { token: session.token, workspaceId: extra.workspaceId ?? session.workspaceId, ...extra };
}

/** Calls a collaboration route through its catch-all handler: `call(session, 'POST', 'tasks/<id>/start', {...})`. */
export async function call(session: Session | null, method: Method, path: string, options: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; workspaceId?: string } = {}): Promise<ApiResult> {
  const [prefix, ...rest] = path.split('/');
  const template = `/api/v1/${prefix}/[[...path]]`;
  const params = { path: rest };
  if (!session) return api(method, template, { params, body: options.body, query: options.query, headers: options.headers, workspaceId: options.workspaceId });
  return api(method, template, { token: session.token, workspaceId: options.workspaceId ?? session.workspaceId, params, body: options.body, query: options.query, headers: options.headers });
}

export function expectOk(result: ApiResult, status = 200) {
  if (result.status !== status || result.body?.success !== true) throw new Error(`Expected ${status} success, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result.data;
}

export function expectError(result: ApiResult, status: number, code?: string) {
  if (result.status !== status || result.body?.success !== false || (code && result.body?.error?.code !== code)) {
    throw new Error(`Expected ${status} ${code ?? ''}, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
  // Error envelopes never leak internals.
  const text = JSON.stringify(result.body);
  if (/prisma|stack|at Object\.|SELECT |INSERT |postgres/i.test(text)) throw new Error(`Error envelope leaks internals: ${text}`);
  return result.body.error as { code: string; message: string; details: any };
}

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';

export const ALL_TASK_PERMISSIONS: Array<[string, PermissionScope]> = [
  'task.create', 'task.read', 'task.update', 'task.delete', 'task.complete', 'task.reopen', 'task.review', 'task.change_deadline',
  'task.change_responsible', 'task.add_participant', 'task.add_observer', 'task.result_submit', 'task.history_view', 'task.checklist_manage',
  'task.checklist_complete', 'task.dependency_manage', 'task.time_add', 'task.time_edit_own',
].map((key) => [key, 'OWN' as PermissionScope]);

export const PROJECT_MEMBER_PERMISSIONS: Array<[string, PermissionScope]> = [
  'project.create', 'project.read', 'project.update', 'project.member_view', 'project.member_manage', 'project.stage_manage', 'project.task_move_stage',
  'project.archive', 'project.tool_manage', 'project.delete',
].map((key) => [key, 'OWN' as PermissionScope]);
