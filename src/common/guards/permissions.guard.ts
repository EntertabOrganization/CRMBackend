import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { JwtPayload } from './jwt-auth.guard';

/**
 * Global guard that checks if the authenticated user has the required
 * permissions for the requested route.
 *
 * - Routes decorated with @Public() are excluded.
 * - Routes without @RequirePermissions() are accessible to any authenticated user.
 * - If @RequirePermissions('perm_a', 'perm_b') is set, the user must have
 *   ALL of the listed permissions.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip for public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Get required permissions from the route metadata
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no permissions are specified, allow any authenticated user
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (!user || !user.permissions) {
      throw new ForbiddenException('Access denied. No permissions found in token.');
    }

    // Check that the user has ALL required permissions
    const hasAllPermissions = requiredPermissions.every((requiredPerm) =>
      user.permissions.includes(requiredPerm),
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException(
        `Access denied. Required permissions: [${requiredPermissions.join(', ')}]`,
      );
    }

    return true;
  }
}
