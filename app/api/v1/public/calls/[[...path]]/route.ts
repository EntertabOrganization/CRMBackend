import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
import type { NextRequest } from 'next/server';
const handlers = collabRouteHandlers('public/calls', () => appContext.collab.router);
// Guest join responses carry media tokens: never cached or leaked through referrers.
export async function POST(request: NextRequest, context: Parameters<typeof handlers.POST>[1]) {
  const response = await handlers.POST(request, context);
  response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
