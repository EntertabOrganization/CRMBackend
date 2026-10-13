import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

const grants = perms('OWN', 'calendar.read', 'calendar.create', 'calendar.update', 'calendar.delete', 'calendar.permission_manage', 'project.read');

describe('Calendars Specification contract', () => {
  it('Department membership changes immediately alter default access; managers need platform permissions', async () => {
    const ctx = await collabApp();
    const manager = await ctx.memberActor('manager', grants);
    const employee = await ctx.memberActor('employee', grants);
    const dept = ctx.app.departments.create(ctx.owner.user, ctx.owner.workspaceId, { name: 'Sales', managerId: manager.user.id });
    const svc = ctx.collab.calendar.calendars;
    const c = svc.create(manager, b({ type: 'DEPARTMENT', name: 'Sales', timezone: 'UTC', departmentId: dept.id }));
    expect(svc.get(manager, c.id).effectiveLevel).toBe('MANAGE');
    await expectAppError(() => svc.get(employee, c.id), 'CALENDAR_NOT_FOUND', 404);
    ctx.app.departments.addMembers(ctx.owner.user, ctx.owner.workspaceId, dept.id, [employee.user.id]);
    expect(svc.get(employee, c.id).effectiveLevel).toBe('CREATE');
    await expectAppError(() => svc.update(employee, c.id, b({ name: 'Hijack', version: 1 }), false), 'PERMISSION_DENIED', 403);
    ctx.app.departments.removeMember(ctx.owner.user, ctx.owner.workspaceId, dept.id, employee.user.id);
    await expectAppError(() => svc.get(employee, c.id), 'CALENDAR_NOT_FOUND', 404);
  });

  it('Cross-workspace owner/department/project and permission subjects cannot be linked', async () => {
    const ctx = await collabApp();
    const foreign = await ctx.foreignActor();
    const dept = ctx.app.departments.create(foreign.user, foreign.workspaceId, { name: 'Foreign' });
    const project = ctx.collab.tasks.projects.create(foreign, b({ name: 'Foreign' }));
    const svc = ctx.collab.calendar.calendars;
    const fields = { name: 'Mine', timezone: 'UTC' };
    await expectAppError(() => svc.create(ctx.owner, b({ ...fields, type: 'PERSONAL', ownerUserId: foreign.user.id })), 'CALENDAR_INVALID_OWNER', 400);
    await expectAppError(() => svc.create(ctx.owner, b({ ...fields, type: 'DEPARTMENT', departmentId: dept.id })), 'DEPARTMENT_NOT_FOUND', 404);
    await expectAppError(() => svc.create(ctx.owner, b({ ...fields, type: 'PROJECT', projectId: project.id })), 'PROJECT_NOT_FOUND', 404);
    const c = svc.create(ctx.owner, b({ ...fields, type: 'PERSONAL' }));
    for (const [subjectType, subjectId] of [['USER', foreign.user.id], ['ROLE', foreign.role.id], ['DEPARTMENT', dept.id]]) {
      await expectAppError(() => svc.replacePermissions(ctx.owner, c.id, b({ version: 1, permissions: [{ subjectType, subjectId, level: 'VIEW' }] })), 'CALENDAR_PERMISSION_INVALID', 400);
    }
    expect(svc.get(ctx.owner, c.id).version).toBe(1);
    await expectAppError(() => svc.get(foreign, c.id), 'CALENDAR_NOT_FOUND', 404);
    await expectAppError(() => svc.updatePreferences(foreign, c.id, b({ isVisible: false })), 'CALENDAR_NOT_FOUND', 404);
  });

  it('Permission override caps inherited access, evaluates all subject types and preserves direct access', async () => {
    const ctx = await collabApp();
    const employee = await ctx.memberActor('employee', grants);
    const svc = ctx.collab.calendar.calendars;
    const project = ctx.collab.tasks.projects.create(ctx.owner, b({ name: 'Board', memberUserIds: [employee.user.id], tools: ['TASKS', 'CALENDAR'] }));
    const cId = ctx.collab.tasks.projects.linkedResources(ctx.owner, project.id).CALENDAR.resourceId!;
    expect(svc.get(employee, cId).effectiveLevel).toBe('CREATE');
    let c = svc.get(ctx.owner, cId);
    svc.replacePermissions(ctx.owner, cId, b({ version: c.version, permissions: [{ subjectType: 'PROJECT_ROLE', subjectId: 'MEMBER', level: 'EDIT_OWN' }, { subjectType: 'USER', subjectId: employee.user.id, level: 'VIEW' }] }));
    expect(svc.get(employee, cId).effectiveLevel).toBe('VIEW');
    ctx.collab.tasks.projects.removeMember(ctx.owner, project.id, employee.user.id);
    expect(svc.get(employee, cId).effectiveLevel).toBe('VIEW');
    c = svc.get(ctx.owner, cId);
    svc.replacePermissions(ctx.owner, cId, b({ version: c.version, permissions: [{ subjectType: 'PROJECT_ROLE', subjectId: 'MEMBER', level: 'VIEW' }] }));
    await expectAppError(() => svc.get(employee, cId), 'CALENDAR_NOT_FOUND', 404);
    const company = svc.create(ctx.owner, b({ type: 'COMPANY', name: 'Company', timezone: 'UTC' }));
    expect(svc.get(employee, company.id).effectiveLevel).toBe('VIEW');
    await expectAppError(() => svc.update(employee, company.id, b({ name: 'No', version: 1 }), false), 'PERMISSION_DENIED', 403);
    svc.replacePermissions(ctx.owner, company.id, b({ version: 1, permissions: [{ subjectType: 'ROLE', subjectId: employee.role.id, level: 'EDIT_ALL' }] }));
    expect(svc.get(employee, company.id).effectiveLevel).toBe('EDIT_ALL');
    const root = ctx.app.departments.create(ctx.owner.user, ctx.owner.workspaceId, { name: 'Root' });
    const child = ctx.app.departments.create(ctx.owner.user, ctx.owner.workspaceId, { name: 'Child', parentDepartmentId: root.id });
    ctx.app.departments.addMembers(ctx.owner.user, ctx.owner.workspaceId, child.id, [employee.user.id]);
    svc.replacePermissions(ctx.owner, company.id, b({ version: 2, permissions: [{ subjectType: 'DEPARTMENT_TREE', subjectId: root.id, level: 'CREATE' }] }));
    expect(svc.get(employee, company.id).effectiveLevel).toBe('CREATE');
    svc.replacePermissions(ctx.owner, company.id, b({ version: 3, permissions: [{ subjectType: 'DEPARTMENT', subjectId: root.id, level: 'CREATE' }] }));
    await expectAppError(() => svc.get(employee, company.id), 'CALENDAR_NOT_FOUND', 404);
    svc.replacePermissions(ctx.owner, company.id, b({ version: 4, permissions: [{ subjectType: 'WORKSPACE', level: 'VIEW' }] }));
    expect(svc.get(employee, company.id).effectiveLevel).toBe('VIEW');
  });

  it('Keeps private calendars private and user preferences independent with optimistic concurrency', async () => {
    const ctx = await collabApp();
    const employee = await ctx.memberActor('employee', grants);
    const svc = ctx.collab.calendar.calendars;
    const c = svc.create(ctx.owner, b({ type: 'PERSONAL', name: 'Private', timezone: 'Africa/Cairo' }));
    await expectAppError(() => svc.get(employee, c.id), 'CALENDAR_NOT_FOUND', 404);
    expect(svc.list(employee, new URLSearchParams()).data).toHaveLength(0);
    svc.replacePermissions(ctx.owner, c.id, b({ version: 1, permissions: [{ subjectType: 'USER', subjectId: employee.user.id, level: 'VIEW' }] }));
    const pref = svc.updatePreferences(employee, c.id, b({ colorPreference: '#00ffaa', isVisible: false }));
    expect(svc.preferences(employee, c.id)).toMatchObject({ colorPreference: '#00ffaa', isVisible: false });
    expect(svc.preferences(ctx.owner, c.id)).toMatchObject({ colorPreference: null, isVisible: true });
    svc.updatePreferences(employee, c.id, b({ isVisible: true, version: pref.version }));
    await expectAppError(() => svc.updatePreferences(employee, c.id, b({ isVisible: false, version: 1 })), 'RESOURCE_VERSION_CONFLICT', 409);
  });

  it('Validates IANA zones and permission replacements atomically', async () => {
    const ctx = await collabApp();
    const svc = ctx.collab.calendar.calendars;
    await expectAppError(() => svc.create(ctx.owner, b({ type: 'PERSONAL', name: 'Invalid', timezone: 'GMT+2' })), 'CALENDAR_INVALID_TIMEZONE', 400);
    const c = svc.create(ctx.owner, b({ type: 'PERSONAL', name: 'Original', timezone: 'UTC' }));
    await expectAppError(() => svc.update(ctx.owner, c.id, b({ name: 'Partial', timezone: 'bad', version: 1 }), false), 'CALENDAR_INVALID_TIMEZONE', 400);
    expect(svc.get(ctx.owner, c.id)).toMatchObject({ name: 'Original', version: 1 });
    await expectAppError(() => svc.replacePermissions(ctx.owner, c.id, b({ version: 1, permissions: [{ subjectType: 'WORKSPACE', level: 'VIEW' }, { subjectType: 'WORKSPACE', level: 'MANAGE' }] })), 'CALENDAR_PERMISSION_INVALID', 400);
    expect(svc.permissions(ctx.owner, c.id)).toMatchObject({ version: 1, permissions: [] });
  });

  it('Project Calendar provisioning is idempotent, archive is read-only and hard delete preserves Calendar history', async () => {
    const ctx = await collabApp();
    const project = ctx.collab.tasks.projects.create(ctx.owner, b({ name: 'Lifecycle', tools: ['TASKS'] }));
    const svc = ctx.collab.calendar.calendars;
    expect(ctx.state.calendars).toHaveLength(0);
    const enabled = ctx.collab.tasks.projects.enableTool(ctx.owner, project.id, 'CALENDAR', true);
    expect(ctx.collab.tasks.projects.enableTool(ctx.owner, project.id, 'CALENDAR', true).linkedResourceId).toBe(enabled.linkedResourceId);
    expect(ctx.state.calendars).toHaveLength(1);
    const id = enabled.linkedResourceId!;
    ctx.collab.tasks.projects.archive(ctx.owner, project.id);
    await expectAppError(() => svc.update(ctx.owner, id, b({ name: 'No', version: svc.get(ctx.owner, id).version }), false), 'PROJECT_ARCHIVED', 409);
    ctx.collab.tasks.projects.unarchive(ctx.owner, project.id);
    svc.update(ctx.owner, id, b({ name: 'Renamed', version: svc.get(ctx.owner, id).version }), false);
    ctx.collab.tasks.projects.softDelete(ctx.owner, project.id);
    ctx.collab.tasks.projects.hardDelete(ctx.owner, project.id);
    expect(svc.get(ctx.owner, id)).toMatchObject({ name: 'Renamed', projectId: null, isReadOnly: true, isDeleted: false });
    expect(ctx.state.outboxEvents.some((row) => row.entityId === id && row.eventType === 'CALENDAR_CREATED')).toBe(true);
  });

  it('Directly created Project Calendars participate in lifecycle handling before tool enablement', async () => {
    const ctx = await collabApp();
    const project = ctx.collab.tasks.projects.create(ctx.owner, b({ name: 'Manual' }));
    const svc = ctx.collab.calendar.calendars;
    const c = svc.create(ctx.owner, b({ type: 'PROJECT', projectId: project.id, name: 'Manual', timezone: 'UTC' }));
    expect(ctx.collab.tasks.projects.listTools(ctx.owner, project.id).find((row) => row.toolType === 'CALENDAR')).toMatchObject({ isEnabled: false, linkedResourceId: c.id });
    ctx.collab.tasks.projects.archive(ctx.owner, project.id);
    expect(svc.get(ctx.owner, c.id).isReadOnly).toBe(true);
    ctx.collab.tasks.projects.unarchive(ctx.owner, project.id);
    ctx.collab.tasks.projects.softDelete(ctx.owner, project.id);
    ctx.collab.tasks.projects.hardDelete(ctx.owner, project.id);
    expect(svc.get(ctx.owner, c.id)).toMatchObject({ projectId: null, isReadOnly: true });
  });

  it('Deleting a linked Calendar clears the Project-owned tool and allows one new canonical Calendar', async () => {
    const ctx = await collabApp();
    const project = ctx.collab.tasks.projects.create(ctx.owner, b({ name: 'Renew', tools: ['CALENDAR'] }));
    const id = ctx.collab.tasks.projects.linkedResources(ctx.owner, project.id).CALENDAR.resourceId!;
    ctx.collab.calendar.calendars.remove(ctx.owner, id);
    expect(ctx.collab.tasks.projects.listTools(ctx.owner, project.id).find((row) => row.toolType === 'CALENDAR')).toMatchObject({ isEnabled: false, linkedResourceId: null });
    const second = ctx.collab.tasks.projects.enableTool(ctx.owner, project.id, 'CALENDAR', true);
    expect(second.linkedResourceId).not.toBe(id);
    expect(ctx.state.calendars.find((row) => row.id === id)).toMatchObject({ isDeleted: true, projectId: null });
    expect(ctx.state.calendars.filter((row) => row.projectId === project.id)).toHaveLength(1);
  });
});
