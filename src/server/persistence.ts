import type { Prisma, PrismaClient } from '@prisma/client';
import type { DbState } from './store';

type Delegate = {
  findMany: (args?: unknown) => Promise<unknown[]>;
  upsert: (args: { where: { id: string }; create: unknown; update: unknown }) => Promise<unknown>;
  deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
};

type TxClient = PrismaClient | Prisma.TransactionClient;

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value == null ? null : (value as Record<string, unknown>);
}

// Parent-to-child order, safe for upserts. Deletes run in the reverse order.
const COLLECTIONS: { key: keyof DbState; delegate: (client: TxClient) => Delegate }[] = [
  { key: 'permissions', delegate: (c) => c.permission as unknown as Delegate },
  { key: 'partnerRoles', delegate: (c) => c.partnerRole as unknown as Delegate },
  { key: 'partners', delegate: (c) => c.partner as unknown as Delegate },
  { key: 'users', delegate: (c) => c.user as unknown as Delegate },
  { key: 'authIdentities', delegate: (c) => c.authIdentity as unknown as Delegate },
  { key: 'refreshSessions', delegate: (c) => c.refreshSession as unknown as Delegate },
  { key: 'emailVerificationTokens', delegate: (c) => c.emailVerificationToken as unknown as Delegate },
  { key: 'passwordResetTokens', delegate: (c) => c.passwordResetToken as unknown as Delegate },
  { key: 'workspaces', delegate: (c) => c.workspace as unknown as Delegate },
  { key: 'roles', delegate: (c) => c.role as unknown as Delegate },
  { key: 'rolePermissions', delegate: (c) => c.rolePermission as unknown as Delegate },
  { key: 'workspaceMemberships', delegate: (c) => c.workspaceMembership as unknown as Delegate },
  { key: 'workspaceInvitations', delegate: (c) => c.workspaceInvitation as unknown as Delegate },
  { key: 'departments', delegate: (c) => c.department as unknown as Delegate },
  { key: 'departmentMembers', delegate: (c) => c.departmentMember as unknown as Delegate },
  { key: 'partnerMemberships', delegate: (c) => c.partnerMembership as unknown as Delegate },
  { key: 'partnerWorkspaceRelations', delegate: (c) => c.partnerWorkspaceRelation as unknown as Delegate },
  { key: 'partnerApplications', delegate: (c) => c.partnerApplication as unknown as Delegate },
  { key: 'auditLogs', delegate: (c) => c.auditLog as unknown as Delegate },
];

export async function hydrateState(client: PrismaClient): Promise<DbState> {
  const [
    users,
    authIdentities,
    refreshSessions,
    emailVerificationTokens,
    passwordResetTokens,
    workspaces,
    workspaceMemberships,
    workspaceInvitations,
    permissions,
    roles,
    rolePermissions,
    departments,
    departmentMembers,
    partnerApplications,
    partners,
    partnerRoles,
    partnerMemberships,
    partnerWorkspaceRelations,
    auditLogs,
  ] = await Promise.all([
    client.user.findMany(),
    client.authIdentity.findMany(),
    client.refreshSession.findMany(),
    client.emailVerificationToken.findMany(),
    client.passwordResetToken.findMany(),
    client.workspace.findMany(),
    client.workspaceMembership.findMany(),
    client.workspaceInvitation.findMany(),
    client.permission.findMany(),
    client.role.findMany(),
    client.rolePermission.findMany(),
    client.department.findMany(),
    client.departmentMember.findMany(),
    client.partnerApplication.findMany(),
    client.partner.findMany(),
    client.partnerRole.findMany(),
    client.partnerMembership.findMany(),
    client.partnerWorkspaceRelation.findMany(),
    client.auditLog.findMany(),
  ]);

  return {
    users: users.map((row) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    authIdentities,
    refreshSessions,
    emailVerificationTokens,
    passwordResetTokens,
    workspaces: workspaces.map((row) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    workspaceMemberships,
    workspaceInvitations,
    permissions,
    roles,
    rolePermissions,
    departments,
    departmentMembers,
    partnerApplications,
    partners: partners.map((row) => ({ ...row, settings: asRecord(row.settings), meta: asRecordOrNull(row.meta) })),
    partnerRoles,
    partnerMemberships,
    partnerWorkspaceRelations,
    auditLogs,
  } as unknown as DbState;
}

export async function persistState(client: PrismaClient, before: DbState, after: DbState): Promise<void> {
  await client.$transaction(
    async (tx) => {
      // Upserts run before deletes: a request can both remove a parent (e.g. hard-delete
      // a workspace) and write a new row that references it (e.g. the audit log entry
      // for that very deletion). Writing first lets the FK check succeed while the
      // parent still exists; the delete phase then relies on the schema's ON DELETE
      // behavior (cascade/set-null) for anything that still points at the removed row.
      for (const { key, delegate } of COLLECTIONS) {
        const beforeById = new Map(
          (before[key] as unknown as { id: string }[]).map((row) => [row.id, row]),
        );
        const rows = after[key] as unknown as { id: string }[];
        const changed = rows.filter((row) => {
          const previous = beforeById.get(row.id);
          return !previous || JSON.stringify(previous) !== JSON.stringify(row);
        });
        if (changed.length === 0) continue;
        const d = delegate(tx);
        for (const row of changed) {
          await d.upsert({ where: { id: row.id }, create: row, update: row });
        }
      }

      for (const { key, delegate } of [...COLLECTIONS].reverse()) {
        const beforeRows = before[key] as unknown as { id: string }[];
        const afterIds = new Set((after[key] as unknown as { id: string }[]).map((row) => row.id));
        const removedIds = beforeRows.filter((row) => !afterIds.has(row.id)).map((row) => row.id);
        if (removedIds.length > 0) {
          await delegate(tx).deleteMany({ where: { id: { in: removedIds } } });
        }
      }
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
