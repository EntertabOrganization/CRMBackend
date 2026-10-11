import type { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
import { rateLimitRequest } from '@/src/server/rate-limit';
import { fail } from '@/src/server/response';
const handlers = collabRouteHandlers('public/files', () => appContext.collab.router);
export async function GET(request: NextRequest, context: Parameters<typeof handlers.GET>[1]) {
  let response;
  try {
    rateLimitRequest(request, { scope: 'public.file.read', limit: 60, windowMs: 60_000 });
    response = await handlers.GET(request, context);
  } catch (error) { response = fail(error); }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
