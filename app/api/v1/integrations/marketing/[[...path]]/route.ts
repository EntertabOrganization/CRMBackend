import type { NextRequest } from 'next/server';
import { marketingPublicRouter } from '@/src/server/marketing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => marketingPublicRouter.dispatch(request);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
