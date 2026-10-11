import { appContext } from '@/src/server/app-context';
import type { NextRequest } from 'next/server';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('generated-documents', () => appContext.collab.router);
// Download responses carry a single-use delivery path; generated business documents are never cached.
const protect = (handler: typeof handlers.GET) => async (request: NextRequest, context: Parameters<typeof handlers.GET>[1]) => {
  const response = await handler(request, context);
  response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer'); return response;
};
export const GET = protect(handlers.GET);
export const POST = protect(handlers.POST);
export const DELETE = handlers.DELETE;
