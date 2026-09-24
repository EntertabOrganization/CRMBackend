import { NextRequest } from 'next/server';
import { appContext } from '@/src/server/app-context';
import { fail, readOnly } from '@/src/server/response';
import { requireWorkspaceContext } from '@/src/server/route-helpers';

/**
 * Advisory realtime stream (Server-Sent Events). Frames are small invalidation hints (ids and versions only) that are
 * released after the originating transaction commits; clients must treat them as a signal to refetch over REST.
 * Authenticate with the normal Bearer header (use fetch streaming; EventSource cannot set headers).
 */
export async function GET(request: NextRequest) {
  const outcome = await readOnly(async () => {
    const { user, workspaceId } = await requireWorkspaceContext(request);
    return { userId: user.id, workspaceId };
  });
  if ('error' in outcome) return fail(outcome.error);
  const { userId, workspaceId } = outcome.result!;

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      write('ready', { workspaceId });
      unsubscribe = appContext.realtime.subscribe({
        workspaceId,
        userId,
        send: (hint) => write(hint.type, { ...hint.data, workspaceId: hint.workspaceId, type: hint.type }),
      });
      heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 25_000);
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' },
  });
}