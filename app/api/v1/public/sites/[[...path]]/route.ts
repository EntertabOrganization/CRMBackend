import type { NextRequest } from 'next/server';
import { sitesPublicRouter } from '@/src/server/sites/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => sitesPublicRouter.dispatch(request);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
