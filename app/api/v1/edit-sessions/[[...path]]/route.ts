import { appContext } from '@/src/server/app-context';
import { collabRouteHandlers } from '@/src/server/collab/http';
import type { NextRequest } from 'next/server';
const handlers = collabRouteHandlers('edit-sessions', () => appContext.collab.router);
const protect = (handler: typeof handlers.GET) => async (request: NextRequest, context: Parameters<typeof handlers.GET>[1]) => {
  const response = await handler(request, context);
  response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer'); return response;
};
export const GET = protect(handlers.GET);
export const POST = protect(handlers.POST);
