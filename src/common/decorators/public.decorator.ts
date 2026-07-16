import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks an endpoint as public — JWT authentication and permission checks
 * will be skipped for this route.
 *
 * Use this decorator for routes like signin, signup, and refresh.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
