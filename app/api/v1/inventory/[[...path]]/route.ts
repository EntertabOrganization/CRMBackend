import type { NextRequest } from 'next/server';
import { inventoryRouter } from '@/src/server/inventory/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => inventoryRouter.dispatch(request);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
