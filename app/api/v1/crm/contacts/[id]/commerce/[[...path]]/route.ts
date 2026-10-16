import type { NextRequest } from 'next/server';
import { commerceRouter } from '@/src/server/commerce/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => commerceRouter.dispatch(request);
