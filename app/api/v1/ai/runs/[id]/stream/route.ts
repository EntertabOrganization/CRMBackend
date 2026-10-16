import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/src/server/prisma-client';
import { authenticate, requirePermission } from '@/src/server/process-platform/context';
import { decrypt, entitled } from '@/src/server/suite/kernel';
import { AiRunService } from '@/src/server/ai/run-service';
import { fail } from '@/src/server/response';
import { AppError } from '@/src/server/errors';
import { SCENARIOS } from '@/src/server/ai/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const runs = new AiRunService(prisma);

/** Bearer headers only; each snapshot re-resolves current membership, entitlement, scenario permission and run ownership. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = (await context.params).id;
  async function snapshot() {
    if (!z.uuid().safeParse(id).success) throw new AppError('VALIDATION_FAILED', 'A valid run ID is required.', 400);
    const actor = await authenticate(prisma, request);
    requirePermission(actor, 'ai.run.readOwn'); entitled(actor, 'ai');
    const view = await runs.get(actor, id);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id } });
    const scenario = SCENARIOS[run.scenarioCode];
    if (scenario) requirePermission(actor, scenario.requiredPermission);
    // Retrieval/tool/structured scenarios remain completion-only; never expose raw tool proposals or unvalidated JSON.
    const safePartial = scenario?.output === 'TEXT' && !scenario.allowTools && !scenario.retrieval;
    return { id, status: run.status, version: run.version, text: safePartial && run.streamSealed ? decrypt(run.streamSealed) : null,
      result: safePartial && run.status === 'SUCCEEDED' ? view.result : null, errorCode: run.errorCode };
  }
  try { await snapshot(); } catch (error) { return fail(error); }
  const encoder = new TextEncoder(); let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + 120000; let previous = '';
      try {
        while (!stopped && !request.signal.aborted && Date.now() < deadline) {
          const state = await snapshot(), json = JSON.stringify(state);
          if (json !== previous && (controller.desiredSize ?? 1) > 0) { controller.enqueue(encoder.encode('event: snapshot\ndata: ' + json + '\n\n')); previous = json; }
          if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL'].includes(state.status)) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!stopped) controller.close();
      } catch { if (!stopped) { controller.enqueue(encoder.encode('event: closed\ndata: {"reason":"ACCESS_CHANGED_OR_UNAVAILABLE"}\n\n')); controller.close(); } }
    },
    cancel() { stopped = true; },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
