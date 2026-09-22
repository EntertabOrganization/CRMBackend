import { verifiedUser } from './helpers';

describe('Department module', () => {
  it('supports unlimited tree operations and ancestor ordering', async () => {
    const { app, user, workspace } = await verifiedUser();
    const sales = app.departments.create(user, workspace.id, { name: 'Sales' });
    const egypt = app.departments.create(user, workspace.id, { name: 'Egypt', parentDepartmentId: sales.id });
    const cairo = app.departments.create(user, workspace.id, { name: 'Cairo', parentDepartmentId: egypt.id });
    const enterprise = app.departments.create(user, workspace.id, { name: 'Enterprise', parentDepartmentId: cairo.id });

    expect(app.departments.children(user, workspace.id, sales.id).map((department) => department.id)).toEqual([egypt.id]);
    expect(app.departments.descendants(user, workspace.id, sales.id).map((department) => department.id)).toEqual([egypt.id, cairo.id, enterprise.id]);
    expect(app.departments.ancestors(user, workspace.id, enterprise.id).map((department) => department.id)).toEqual([sales.id, egypt.id, cairo.id]);
  });

  it('blocks self-parent, cycles, sibling duplicates and soft delete with children', async () => {
    const { app, user, workspace } = await verifiedUser();
    const sales = app.departments.create(user, workspace.id, { name: 'Sales' });
    const cairo = app.departments.create(user, workspace.id, { name: 'Cairo', parentDepartmentId: sales.id });
    expect(() => app.departments.move(user, workspace.id, sales.id, sales.id)).toThrow('Department cannot parent itself.');
    expect(() => app.departments.move(user, workspace.id, sales.id, cairo.id)).toThrow('Department cannot move under its descendant.');
    expect(() => app.departments.create(user, workspace.id, { name: 'Cairo', parentDepartmentId: sales.id })).toThrow('Department name must be unique among active siblings.');
    expect(() => app.departments.softDelete(user, workspace.id, sales.id)).toThrow('Move or delete child departments first.');
  });

  it('rejects department members from another workspace and blocks manager removal', async () => {
    const { app, user, workspace } = await verifiedUser();
    const engineering = app.departments.create(user, workspace.id, { name: 'Engineering' });
    const other = await app.auth.signup({ firstName: 'Nour', lastName: 'Ali', email: 'nour@example.com', password: 'Password1' });
    const otherSession = await app.auth.verifyEmail(other.verificationToken);

    expect(() => app.departments.addMembers(user, workspace.id, engineering.id, [otherSession.user.id])).toThrow('User must have active membership in the workspace.');
    app.departments.addMembers(user, workspace.id, engineering.id, [user.id]);
    app.store.state.departments.find((department) => department.id === engineering.id)!.managerId = user.id;
    expect(() => app.departments.removeMember(user, workspace.id, engineering.id, user.id)).toThrow('Clear or change manager before removing membership.');
  });
});
