import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extracts the current user payload from the request object.
 * The payload is set by the JwtAuthGuard after verifying the JWT token.
 *
 * Returns the full JWT payload containing: userId, email, companyId, roleNames, permissions.
 *
 * @example
 * @Get('profile')
 * getProfile(@CurrentUser() user: JwtPayload) {
 *   return user;
 * }
 *
 * @Get('profile')
 * getEmail(@CurrentUser('email') email: string) {
 *   return email;
 * }
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    if (data) {
      return user?.[data];
    }

    return user;
  },
);
