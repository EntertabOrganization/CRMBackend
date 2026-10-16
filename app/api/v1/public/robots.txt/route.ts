import type { NextRequest } from 'next/server';
import { sitesPublicRouter } from '@/src/server/sites/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Serves the active release's robots.txt for the verified host as plain content (never private slugs). */
export async function GET(request: NextRequest) {
  const response = await sitesPublicRouter.dispatch(request);
  if (response.status !== 200) return response;
  const body = await response.json() as { data: { contentType: string; body: string } };
  return new Response(body.data.body, { status: 200, headers: { 'content-type': body.data.contentType + '; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
