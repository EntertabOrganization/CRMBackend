import type { NextRequest } from 'next/server';
import { workflowRouter } from '@/src/server/workflows/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => workflowRouter.dispatch(request);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
