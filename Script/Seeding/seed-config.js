const ADMIN_EMAIL = 'Admin@entertab.com';
const ADMIN_PASSWORD = 'Admin@1234';
const ADMIN_FIRST_NAME = 'EntertabCRM';
const ADMIN_LAST_NAME = 'Admin';
const ADMIN_WORKSPACE_NAME = 'entertab';
const ADMIN_WORKSPACE_SLUG = 'entertab';
const ADMIN_ROLE_NAME = 'Owner/Admin';

const PERMISSIONS = [
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
];

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_FIRST_NAME,
  ADMIN_LAST_NAME,
  ADMIN_WORKSPACE_NAME,
  ADMIN_WORKSPACE_SLUG,
  ADMIN_ROLE_NAME,
  PERMISSIONS,
};
