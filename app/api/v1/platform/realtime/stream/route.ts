import type { NextRequest } from 'next/server';
import { prisma } from '@/src/server/prisma-client';
import { PlatformRealtimeService } from '@/src/server/platform/realtime-service';
import '@/src/server/platform/register';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const realtime = new PlatformRealtimeService(prisma);

/** Server-sent hints. The token is verified and access re-resolved on every cycle; revocation closes the stream. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  try { await realtime.authorize(q.get('token') ?? '', q.get('topics') ?? ''); }
  catch { return Response.json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Realtime token is invalid or access changed.', details: null } }, { status: 401 }); }
  return new Response(realtime.stream(q.get('token') ?? '', q.get('topics') ?? '', q.get('cursor'), request.signal), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
}
