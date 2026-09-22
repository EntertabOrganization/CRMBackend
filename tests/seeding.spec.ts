const seedConfig = require('../Script/Seeding/seed-config');

describe('database seed configuration', () => {
  it('uses the requested admin credentials', () => {
    expect(seedConfig.ADMIN_EMAIL).toBe('Admin@entertab.com');
    expect(seedConfig.ADMIN_PASSWORD).toBe('Admin@1234');
  });

  it('uses the requested admin workspace', () => {
    expect(seedConfig.ADMIN_WORKSPACE_NAME).toBe('entertab');
    expect(seedConfig.ADMIN_WORKSPACE_SLUG).toBe('entertab');
  });

  it('includes the full permission catalog for the admin role', () => {
    expect(seedConfig.PERMISSIONS).toEqual(
      expect.arrayContaining([
        'workspace.read',
        'workspace.create',
        'workspace.update',
        'workspace.delete',
        'user.read',
        'user.create',
        'user.update',
        'user.delete',
        'department.read',
        'department.create',
        'department.update',
        'department.delete',
        'role.read',
        'role.create',
        'role.update',
        'role.delete',
        'audit.read',
        'partner.company.create',
        'partner.billing.manage',
      ]),
    );
    expect(seedConfig.PERMISSIONS).toHaveLength(19);
  });
});
