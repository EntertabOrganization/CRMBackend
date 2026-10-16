import type { NextRequest } from 'next/server';
import { marketingPublicRouter } from '@/src/server/marketing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: NextRequest) => marketingPublicRouter.dispatch(request);
