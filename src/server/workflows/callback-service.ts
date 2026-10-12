import { Prisma,type PrismaClient } from '@prisma/client';
import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { canonical,parse } from '../process-platform/dto';
import { evidence,lock,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { assertNoSecrets } from './graph-validator';
import type { WorkflowRuntime } from './runtime';
import { checkRateLimit,processRateLimitPolicies } from '../rate-limit';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const proofInput = z.strictObject({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),payload: z.record(z.string(),z.json()) });
const denied = () => new AppError('PERMISSION_DENIED','Callback proof is invalid.',403);
const equal = (a: string,b: string) => { const x = Buffer.from(a),y = Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };

/** Only hashes persist. Tokens and nonce proofs are reconstructed from the callback ID and configured signing key. */
export class WorkflowCallbackService {
  constructor(private readonly db: PrismaClient,private readonly runtime: WorkflowRuntime,
    private readonly signingKey = () => process.env.WORKFLOW_CALLBACK_SIGNING_KEY ?? process.env.JWT_ACCESS_SECRET,
    private readonly publicOrigin = () => process.env.APP_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL) {}
  private key() {
    const key = this.signingKey(); if (!key || key.length<32) throw new AppError('WORKFLOW_CONNECTION_NOT_FOUND','Callback signing is not configured.',503); return key;
  }
  private token(id: string,workspaceId: string,executionId: string,nodeRunId: string,expiresAt: Date) {
    const nonce = createHmac('sha256',this.key()).update('workflow.callback.nonce:' + id).digest('base64url');
    const body = Buffer.from(canonical({ id,workspaceId,executionId,nodeRunId,expiresAt: expiresAt.toISOString() })).toString('base64url');
    const signature = createHmac('sha256',this.key()).update('workflow.callback.token:' + body).digest('base64url');
    return { token: body + '.' + signature,nonce };
  }
  async issue(tx: Tx, actor: Principal, executionId: string, nodeRunId: string) {
    const configuredOrigin = this.publicOrigin(); let origin: URL;
    try { origin = new URL(configuredOrigin ?? ''); } catch { throw new AppError('WORKFLOW_CONNECTION_NOT_FOUND','Callback public origin is not configured.',503); }
    if (!['https:','http:'].includes(origin.protocol) || origin.protocol!=='https:' && process.env.NODE_ENV==='production' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash)
      throw new AppError('WORKFLOW_CONNECTION_NOT_FOUND','Callback public origin is invalid.',503);
    const prior = await tx.workflowExternalCallback.findUnique({ where: { workspaceId_nodeRunId: { workspaceId: actor.workspaceId,nodeRunId } } });
    const id = prior?.id ?? randomUUID(), expiresAt = prior?.expiresAt ?? new Date(Date.now()+3600000);
    if (expiresAt<=new Date()) throw new AppError('WORKFLOW_CALLBACK_EXPIRED','Callback has expired.',409);
    const credential = this.token(id,actor.workspaceId,executionId,nodeRunId,expiresAt);
    if (prior && !equal(prior.tokenHash,digest(credential.token))) throw new AppError('WORKFLOW_CALLBACK_EXPIRED','Callback signing key changed.',409);
    if (!prior) await tx.workflowExternalCallback.create({ data: { id,workspaceId: actor.workspaceId,executionId,nodeRunId,expiresAt,
      tokenHash: digest(credential.token),nonceHash: digest(credential.nonce) } });
    return { url: new URL('/api/v1/workflows/callbacks/' + credential.token,origin).toString(),nonce: credential.nonce,expiresAt: expiresAt.toISOString() };
  }
  async receive(token: string,raw: unknown,signature: string | null) {
    checkRateLimit('public',processRateLimitPolicies.callbackGlobal);
    if (!token || token.length>1500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
    checkRateLimit(digest(token),processRateLimitPolicies.callback);
    const [body,tokenSignature] = token.split('.');
    const expected = createHmac('sha256',this.key()).update('workflow.callback.token:' + body).digest('base64url');
    if (!equal(tokenSignature,expected)) throw denied();
    const input = parse(proofInput,raw); assertNoSecrets(input.payload);
    if (Buffer.byteLength(canonical(input.payload))>20000) throw new AppError('INVALID_ARGUMENT','Callback payload exceeds its limit.',400);
    const messageSignature = createHmac('sha256',input.nonce).update(canonical(input)).digest('base64url');
    if (!signature || !equal(signature,messageSignature)) throw denied();
    const callback = await this.db.workflowExternalCallback.findUnique({ where: { tokenHash: digest(token) } });
    if (!callback || !equal(callback.nonceHash,digest(input.nonce))) throw denied();
    return this.db.$transaction(async tx => {
      await lock(tx,callback.workspaceId,'workflow:execution:' + callback.executionId);
      const current = await tx.workflowExternalCallback.findFirst({ where: { workspaceId: callback.workspaceId,id: callback.id,tokenHash: digest(token) } });
      if (!current) throw denied();
      if (current.expiresAt<=new Date()) throw new AppError('WORKFLOW_CALLBACK_EXPIRED','Callback has expired.',410);
      const payloadHash = digest(canonical(input.payload));
      if (current.status!=='PENDING') {
        if (current.payloadHash!==payloadHash) throw new AppError('WORKFLOW_CALLBACK_REPLAY','Callback nonce was already used.',409);
        return { accepted: true,duplicate: true };
      }
      const execution = await tx.workflowExecution.findFirst({ where: { workspaceId: current.workspaceId,id: current.executionId,status: { in: ['RUNNING','WAITING','SUSPENDED'] } } });
      if (!execution) throw new AppError('WORKFLOW_INVALID_STATE','Callback execution is closed.',409);
      await tx.workflowExternalCallback.update({ where: { id: current.id },data: { status: 'RECEIVED',receivedAt: new Date(),payloadHash,receivedPayload: input.payload as Prisma.InputJsonValue } });
      const actor = await resolvePrincipal(tx,current.workspaceId,execution.executionUserId);
      await evidence(tx,actor,'WORKFLOW_EXECUTION',current.executionId,'WORKFLOW_EXTERNAL_CALLBACK_RECEIVED',{ callbackId: current.id,nodeRunId: current.nodeRunId });
      return { accepted: true,duplicate: false };
    });
  }
  async tick(limit = 20) {
    const due = await this.db.workflowExternalCallback.findMany({ where: { status: 'RECEIVED' },orderBy: { receivedAt: 'asc' },take: limit });
    let resumed = 0;
    for (const candidate of due) {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:execution:' + candidate.executionId);
        const current = await tx.workflowExternalCallback.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: 'RECEIVED' } });
        if (!current) return false;
        if (!await this.runtime.resumeWait(tx,current.workspaceId,current.executionId,current.nodeRunId,{ callback: current.receivedPayload })) return false;
        await tx.workflowExternalCallback.update({ where: { id: current.id },data: { status: 'FULFILLED' } }); return true;
      },{ timeout: 60000 });
      if (done) resumed++;
    }
    const expired = await this.db.workflowExternalCallback.findMany({ where: { status: 'PENDING',expiresAt: { lte: new Date() } },take: limit });
    for (const callback of expired) await this.db.$transaction(async tx => {
      await this.runtime.failWait(tx,callback.workspaceId,callback.executionId,callback.nodeRunId,'WORKFLOW_CALLBACK_EXPIRED');
      await tx.workflowExternalCallback.updateMany({ where: { workspaceId: callback.workspaceId,id: callback.id,status: 'PENDING' },data: { status: 'EXPIRED' } });
    });
    return { candidates: due.length,resumed,expired: expired.length };
  }
}
