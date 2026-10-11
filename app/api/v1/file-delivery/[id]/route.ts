import { NextRequest, NextResponse } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { fail, runStateUnit } from '@/src/server/response';
import { rateLimitRequest } from '@/src/server/rate-limit';
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let response;
  try {
    rateLimitRequest(request, { scope: 'file.delivery', limit: 60, windowMs: 60_000 });
    const { id } = await context.params;
    const result = await runStateUnit(() => appContext.collab.files.delivery.redeem(id, request.nextUrl.searchParams,
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'));
    // Always attachment + octet-stream: provider MIME and caller-controlled names cannot create active content.
    const name = encodeURIComponent(Buffer.from(result.name, 'utf8').toString('utf8')).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    response = new NextResponse(new Uint8Array(result.bytes), { headers: { 'Content-Type': 'application/octet-stream',
      'Content-Length': String(result.bytes.length), 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${name}` } });
  } catch (error) { response = fail(error); }
  response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  return response;
}
