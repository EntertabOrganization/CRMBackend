import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Decorator that specifies which permission slugs are required for a route.
 *
 * The PermissionsGuard will check that the JWT user has at least one of
 * the specified permission slugs in their token claims.
 *
 * @example
 * @RequirePermissions('company_create')
 * @RequirePermissions('users_read', 'users_update')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
