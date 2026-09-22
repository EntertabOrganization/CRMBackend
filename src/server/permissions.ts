import type { Permission } from './domain';

export const PERMISSION_CATALOG = [
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
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number];

export function catalogPermissions(): Permission[] {
  return PERMISSION_CATALOG.map((key) => {
    const [resource, action] = key.split('.');
    return {
      id: key,
      key,
      name: key,
      description: `${key} permission`,
      module: resource,
      resource,
      action,
      isDeleted: false,
    };
  });
}
