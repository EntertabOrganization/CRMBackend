import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { isAppError } from '@/src/server/errors';
import { prisma } from '@/src/server/prisma-client';
import { authenticateUser, resolvePlatformPrincipal } from '@/src/server/platform/kernel';
import { PartnerProgramService } from '@/src/server/partners/program-service';

export const runtime = 'nodejs';
const program = new PartnerProgramService(prisma);

/**
 * Legacy Auth-pack path kept for compatibility. Authority now comes from an explicit platform role
 * (platform.partner.application.approve) instead of an email-domain check (decision D3).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    const user = await authenticateUser(request.headers.get('authorization'));
    const actor = await resolvePlatformPrincipal(prisma, user.userId);
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { expectedVersion?: number; idempotencyKey?: string };
    const app = await prisma.partnerApplication.findFirst({ where: { id, isDeleted: false } });
    if (!app) return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Partner application was not found.', details: null }, requestId }, { status: 404 });
    const data = await program.approve(actor, id, { expectedVersion: body.expectedVersion ?? app.version, idempotencyKey: body.idempotencyKey ?? 'legacy-approve:' + id }, request.headers.get('x-mfa-assertion'), requestId);
    return NextResponse.json({ success: true, data, meta: null });
  } catch (error) {
    const e = isAppError(error) ? error : null;
    return NextResponse.json({ success: false, error: { code: e?.code ?? 'INTERNAL_ERROR', message: e?.message ?? 'Request could not be completed.', details: e?.details ?? null }, requestId }, { status: e?.status ?? 500 });
  }
}
