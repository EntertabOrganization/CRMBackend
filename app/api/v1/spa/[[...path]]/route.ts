import type { NextRequest } from 'next/server';
import { spaRouter } from '@/src/server/spa/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => spaRouter.dispatch(request);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
