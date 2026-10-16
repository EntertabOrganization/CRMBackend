import type { NextRequest } from 'next/server';
import { commercePublicRouter } from '@/src/server/commerce/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: NextRequest) => commercePublicRouter.dispatch(request);
export const PATCH = POST;
export const DELETE = POST;
