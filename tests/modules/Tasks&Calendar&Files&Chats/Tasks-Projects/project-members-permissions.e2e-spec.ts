/**
 * TrueCRM API E2E contract for Project Members & Contextual Permissions Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { ALL_TASK_PERMISSIONS, MISSING_ID, PROJECT_MEMBER_PERMISSIONS, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let alice: Session;
let bob: Session;
let noPerm: Session;
let outsider: Session;

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('members-owner');
  alice = await member(owner, 'members-alice', [...PROJECT_MEMBER_PERMISSIONS, ...ALL_TASK_PERMISSIONS, ['project.owner_transfer', 'OWN'], ['project.permission_view', 'OWN']]);
  bob = await member(owner, 'members-bob', [...PROJECT_MEMBER_PERMISSIONS, ...ALL_TASK_PERMISSIONS]);
  noPerm = await member(owner, 'members-noperm', [['project.read', 'OWN']]);
  outsider = await register('members-outsider');
});

afterAll(disconnect);

async function newProject(body: Record<string, unknown> = {}) {
  return expectOk(await call(owner, 'POST', 'projects', { body: { name: `Team ${Math.random().toString(36).slice(2, 8)}`, ...body } }));
}

describe('Project Members & Contextual Permissions Specification E2E contract', () => {
  it('exposes and enforces representative routes: GET    /api/v1/projects/:projectId/members; POST   /api/v1/projects/:projectId/members; GET    /api/v1/projects/:projectId/members/:userId; PATCH  /api/v1/projects/:projectId/members/:userId', async () => {
    const project = await newProject();
    const added = expectOk(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: alice.userId, memberRole: 'MODERATOR' } }));
    expect(added).toMatchObject({ userId: alice.userId, memberRole: 'MODERATOR', status: 'ACTIVE', invitedByUserId: owner.userId });
    // Adding an active member again is idempotent.
    expect(expectOk(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: alice.userId } })).id).toBe(added.id);
    const listed = await call(alice, 'GET', `projects/${project.id}/members`);
    expect(expectOk(listed).map((row: any) => row.userId).sort()).toEqual([alice.userId, owner.userId].sort());
    expect(listed.body.meta.total).toBe(2);
    const one = expectOk(await call(alice, 'GET', `projects/${project.id}/members/${owner.userId}`));
    expect(one).toMatchObject({ memberRole: 'OWNER', user: { id: owner.userId } });
    expectError(await call(alice, 'GET', `projects/${project.id}/members/${MISSING_ID}`), 404, 'PROJECT_MEMBER_NOT_FOUND');
    // A moderator manages membership.
    expectOk(await call(alice, 'POST', `projects/${project.id}/members`, { body: { userId: bob.userId } }));
    const bobRow = expectOk(await call(alice, 'GET', `projects/${project.id}/members/${bob.userId}`));
    const promoted = expectOk(await call(alice, 'PATCH', `projects/${project.id}/members/${bob.userId}`, { body: { memberRole: 'MODERATOR', version: bobRow.version } }));
    expect(promoted).toMatchObject({ memberRole: 'MODERATOR', version: bobRow.version + 1 });
    expectError(await call(alice, 'PATCH', `projects/${project.id}/members/${bob.userId}`, { body: { memberRole: 'MEMBER', version: bobRow.version } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(alice, 'PATCH', `projects/${project.id}/members/${bob.userId}`, { body: { memberRole: 'OWNER', version: promoted.version } }), 400, 'VALIDATION_ERROR');
    // DELETE + REMOVED status visible via filter; re-adding reactivates the same row.
    expectOk(await call(alice, 'DELETE', `projects/${project.id}/members/${bob.userId}`));
    expect(expectOk(await call(alice, 'GET', `projects/${project.id}/members`, { query: { status: 'REMOVED' } })).map((row: any) => row.userId)).toEqual([bob.userId]);
    expectError(await call(alice, 'DELETE', `projects/${project.id}/members/${bob.userId}`), 404, 'PROJECT_MEMBER_NOT_FOUND');
    expect(expectOk(await call(alice, 'POST', `projects/${project.id}/members`, { body: { userId: bob.userId } })).id).toBe(bobRow.id);
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const project = await newProject({ visibility: 'WORKSPACE_VISIBLE' });
    expectError(await call(null, 'GET', `projects/${project.id}/members`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(noPerm, 'GET', `projects/${project.id}/members`), 403, 'PERMISSION_DENIED');
    // Visible, but adding others needs a managing role.
    expectError(await call(bob, 'POST', `projects/${project.id}/members`, { body: { userId: alice.userId } }), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'GET', `projects/${project.id}/members`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    expectError(await call(bob, 'POST', `projects/${project.id}/transfer-ownership`, { body: { newOwnerUserId: bob.userId } }), 403, 'PERMISSION_DENIED');
    expectError(await call(bob, 'GET', `projects/${project.id}/permissions/effective`, { query: { userId: owner.userId } }), 403, 'PERMISSION_DENIED');
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const project = await newProject({ visibility: 'OPEN' });
    for (const [method, path] of [
      ['GET', `projects/${project.id}/members`], ['POST', `projects/${project.id}/members`], ['GET', `projects/${project.id}/members/${owner.userId}`],
      ['DELETE', `projects/${project.id}/members/${owner.userId}`], ['POST', `projects/${project.id}/transfer-ownership`], ['GET', `projects/${project.id}/permissions/effective`],
    ] as const) {
      expectError(await call(outsider, method, path, { body: method === 'POST' ? { userId: outsider.userId, newOwnerUserId: outsider.userId } : undefined }), 404, 'PROJECT_NOT_FOUND');
    }
    // A user of another workspace can never become a member: external people collaborate through Collabs.
    expectError(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: outsider.userId } }), 400, 'PROJECT_EXTERNAL_MEMBER_NOT_ALLOWED');
    expectError(await call(owner, 'POST', `projects/${project.id}/transfer-ownership`, { body: { newOwnerUserId: outsider.userId } }), 400, 'PROJECT_OWNER_TRANSFER_INVALID');
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const project = await newProject();
    expectError(await call(owner, 'POST', `projects/${project.id}/members`, { body: {} }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: 'nope' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: alice.userId, memberRole: 'OWNER' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'DELETE', `projects/${project.id}/members/${owner.userId}`), 409, 'PROJECT_OWNER_REQUIRED');
    expectError(await call(owner, 'PATCH', `projects/${project.id}/members/${owner.userId}`, { body: { memberRole: 'MEMBER', version: 1 } }), 409, 'PROJECT_OWNER_REQUIRED');
    expectError(await call(owner, 'POST', `projects/${project.id}/transfer-ownership`, { body: { newOwnerUserId: owner.userId } }), 400, 'PROJECT_OWNER_TRANSFER_INVALID');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const project = await newProject();
    expectOk(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: alice.userId } }));
    const transferred = expectOk(await call(owner, 'POST', `projects/${project.id}/transfer-ownership`, { body: { newOwnerUserId: alice.userId, version: project.version } }));
    expect(transferred).toMatchObject({ ownerUserId: alice.userId, myRole: 'MODERATOR' });
    const prisma = await db();
    const rows = await prisma.projectMember.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.userId, row.memberRole, row.status])).toEqual([[owner.userId, 'MODERATOR', 'ACTIVE'], [alice.userId, 'OWNER', 'ACTIVE']]);
    // Transfer back in one request: the deferred single-owner rule holds at commit regardless of write order.
    expectOk(await call(alice, 'POST', `projects/${project.id}/transfer-ownership`, { body: { newOwnerUserId: owner.userId } }));
    expect((await prisma.projectMember.findMany({ where: { projectId: project.id, memberRole: 'OWNER' } })).map((row) => row.userId)).toEqual([owner.userId]);
    expect((await prisma.auditLog.findMany({ where: { entityId: project.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['PROJECT.MEMBER_ADDED', 'PROJECT.OWNER_CHANGED']));
    expect(await prisma.outboxEvent.count({ where: { entityId: project.id, eventType: 'PROJECT_OWNER_CHANGED' } })).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { entityId: project.id, eventType: 'PROJECT_MEMBER_CHANGED' } })).toBe(1);
  });
});

describe('Self-service membership and effective permissions', () => {
  it('OPEN projects allow self-join and self-leave; effective permissions reflect the contextual role', async () => {
    const open = await newProject({ visibility: 'OPEN' });
    const invite = await newProject({ visibility: 'INVITE_ONLY' });
    const before = expectOk(await call(bob, 'GET', `projects/${open.id}/permissions/effective`));
    expect(before).toMatchObject({ projectRole: null, canJoin: true, canUpdate: false, canManageMembers: false });
    expectOk(await call(bob, 'POST', `projects/${open.id}/members`, { body: { userId: bob.userId } }));
    expectError(await call(bob, 'POST', `projects/${invite.id}/members`, { body: { userId: bob.userId } }), 403, 'PERMISSION_DENIED');
    const after = expectOk(await call(bob, 'GET', `projects/${open.id}/permissions/effective`));
    expect(after).toMatchObject({ projectRole: 'MEMBER', canJoin: false, canCreateTasks: true, canUpdate: false });
    const ownerView = expectOk(await call(owner, 'GET', `projects/${open.id}/permissions/effective`));
    expect(ownerView).toMatchObject({ projectRole: 'OWNER', canUpdate: true, canManageMembers: true, canTransferOwnership: true });
    const asSeenByOwner = expectOk(await call(owner, 'GET', `projects/${open.id}/permissions/effective`, { query: { userId: bob.userId } }));
    expect(asSeenByOwner.userId).toBe(bob.userId);
    expect(asSeenByOwner.projectRole).toBe('MEMBER');
    expectOk(await call(bob, 'DELETE', `projects/${open.id}/members/${bob.userId}`));
    expect(expectOk(await call(bob, 'GET', `projects/${open.id}/permissions/effective`)).projectRole).toBeNull();
  });
});
