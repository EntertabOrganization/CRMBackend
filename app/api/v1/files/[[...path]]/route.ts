import { appContext } from '@/src/server/app-context';
import type { NextRequest } from 'next/server';
import { collabRouteHandlers } from '@/src/server/collab/http';
const handlers = collabRouteHandlers('files', () => appContext.collab.router);
export async function GET(request: NextRequest, context: Parameters<typeof handlers.GET>[1]) {
  const response = await handlers.GET(request, context);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
export async function POST(request: NextRequest, context: Parameters<typeof handlers.POST>[1]) {
  const response = await handlers.POST(request, context);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
