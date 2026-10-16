import { NextResponse, type NextRequest } from 'next/server';
import { marketingPublicRouter } from '@/src/server/marketing/routes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Tracking links answer with a controlled 302 to the pre-registered destination; everything else is JSON. */
export async function GET(request: NextRequest) {
  const response = await marketingPublicRouter.dispatch(request);
  if (!/\/public\/marketing\/track\//.test(request.nextUrl.pathname) || response.status !== 200) return response;
  const body = await response.json() as { data?: { redirectTo?: string } };
  return body.data?.redirectTo ? NextResponse.redirect(body.data.redirectTo, 302) : NextResponse.json(body, { status: 200 });
}
export const POST = (request: NextRequest) => marketingPublicRouter.dispatch(request);
