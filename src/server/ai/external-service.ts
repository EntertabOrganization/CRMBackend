import type { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { enforceRateLimit } from '../platform/governance-service';
import { audit, emitEvent, notFound } from '../platform/kernel';
import { encrypt, entitled } from '../suite/kernel';
import { executeToolCall } from './run-service';
import { allTools, toolByCode } from './registry';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const CODE_TTL_MS = 5 * 60000, ACCESS_TTL_MS = 60 * 60000, GRANT_DAYS = 30;
const SCOPES = ['tools:read', 'tools:invoke', 'conversations:read'] as const;
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const httpsUri = z.url().max(500).refine(u => u.startsWith('https://') && !u.includes('*') && !u.includes('#'), 'Redirect URIs must be exact https URLs without wildcards or fragments.');

/** External MCP / OAuth clients (29/08): short-lived PKCE grants bound to scopes and tools; every call re-resolves authority. */
export class AiExternalService {
  constructor(private readonly db: PrismaClient) {}

  async createClient(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.mcp.manage');
    const input = z.strictObject({ name: z.string().trim().min(2).max(120), clientType: z.enum(['MCP', 'OAUTH_APP']).default('MCP'), redirectUris: z.array(httpsUri).min(1).max(10), scopes: z.array(z.enum(SCOPES)).min(1), allowedScenarios: z.array(z.string().max(80)).max(20).default([]) }).parse(raw);
    const secret = randomBytes(32).toString('base64url'), publicClientId = 'tcrm_' + randomBytes(12).toString('hex');
    return this.db.$transaction(async tx => {
      const row = await tx.aiExternalClient.create({ data: { workspaceId: actor.workspaceId, name: input.name, clientType: input.clientType, publicClientId, secretHash: sha(secret), redirectUris: input.redirectUris, scopes: input.scopes, allowedScenarios: input.allowedScenarios, createdBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_EXTERNAL_CLIENT_CREATED', resourceType: 'AiExternalClient', resourceId: row.id, after: { name: input.name, scopes: input.scopes, redirects: input.redirectUris.length }, requestId });
      return { id: row.id, clientId: publicClientId, clientSecret: secret, note: 'The secret is shown once; only its hash is stored.' };
    });
  }
  async clients(actor: Principal) {
    requirePermission(actor, 'ai.mcp.manage');
    return this.db.aiExternalClient.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, clientType: true, publicClientId: true, redirectUris: true, scopes: true, status: true, createdAt: true } });
  }
  async revokeClient(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'ai.mcp.manage');
    return this.db.$transaction(async tx => {
      const r = await tx.aiExternalClient.updateMany({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, status: 'ACTIVE' }, data: { status: 'REVOKED' } }); if (!r.count) throw notFound('Client');
      await tx.aiExternalGrant.updateMany({ where: { clientId: id, revokedAt: null }, data: { revokedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_EXTERNAL_CLIENT_REVOKED', resourceType: 'AiExternalClient', resourceId: id, requestId });
      return { id, status: 'REVOKED' };
    });
  }
  /** Interactive consent by the signed-in user: PKCE S256 + exact redirect + state; tools narrowed to what the user may use. */
  async authorize(actor: Principal, clientId: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.external.connect'); entitled(actor, 'ai');
    const input = z.strictObject({ scopes: z.array(z.enum(SCOPES)).min(1), toolIds: z.array(z.string().max(80)).max(30).default([]), redirectUri: httpsUri, state: z.string().min(8).max(200), codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), codeChallengeMethod: z.literal('S256') }).parse(raw);
    const client = await this.db.aiExternalClient.findFirst({ where: { id: z.uuid().parse(clientId), workspaceId: actor.workspaceId, status: 'ACTIVE' } }); if (!client) throw notFound('Client');
    if (!(client.redirectUris as string[]).includes(input.redirectUri)) throw new AppError('VALIDATION_FAILED', 'Redirect URI is not registered for this client.', 400);
    if (input.scopes.some(s => !(client.scopes as string[]).includes(s))) throw new AppError('VALIDATION_FAILED', 'Requested scope exceeds the client registration.', 400);
    for (const t of input.toolIds) { const tool = toolByCode(t); if (!tool || !actor.grants.has(tool.requiredPermission)) throw new AppError('PERMISSION_DENIED', 'You cannot delegate a tool you are not allowed to use.', 403); }
    const code = randomBytes(32).toString('base64url');
    await this.db.$transaction(async tx => {
      await tx.aiExternalAuthCode.create({ data: { clientId: client.id, workspaceId: actor.workspaceId, userId: actor.userId, codeHash: sha(code), codeChallenge: input.codeChallenge, redirectUri: input.redirectUri, scopes: input.scopes, toolIds: input.toolIds, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_EXTERNAL_CONSENT_GIVEN', resourceType: 'AiExternalClient', resourceId: client.id, after: { scopes: input.scopes, tools: input.toolIds }, requestId });
    });
    return { redirectTo: `${input.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(input.state)}` };
  }
  /** OAuth token endpoint: code+PKCE exchange or rotating refresh; tokens are random, only fingerprints stored. */
  async token(raw: unknown, ip: string | null) {
    await enforceRateLimit(this.db, 'ai.oauth.token', 'IP', ip ?? 'unknown', { requests: 30, windowSeconds: 60 });
    const input = z.discriminatedUnion('grant_type', [
      z.strictObject({ grant_type: z.literal('authorization_code'), code: z.string().min(20).max(200), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), client_id: z.string().max(80), client_secret: z.string().max(200), redirect_uri: z.string().max(500) }),
      z.strictObject({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(20).max(200), client_id: z.string().max(80), client_secret: z.string().max(200) })]).parse(raw);
    const client = await this.db.aiExternalClient.findUnique({ where: { publicClientId: input.client_id } });
    const invalid = new AppError('UNAUTHENTICATED', 'invalid_grant', 401);
    if (!client || client.status !== 'ACTIVE' || !safeEq(client.secretHash, sha(input.client_secret))) throw invalid;
    const access = randomBytes(32).toString('base64url'), refresh = randomBytes(32).toString('base64url');
    return this.db.$transaction(async tx => {
      let grantId: string;
      if (input.grant_type === 'authorization_code') {
        const code = await tx.aiExternalAuthCode.findUnique({ where: { codeHash: sha(input.code) } });
        if (!code || code.clientId !== client.id || code.usedAt || code.expiresAt <= new Date() || code.redirectUri !== input.redirect_uri) throw invalid;
        if (!safeEq(code.codeChallenge, createHash('sha256').update(input.code_verifier).digest('base64url'))) throw invalid;
        await tx.aiExternalAuthCode.update({ where: { id: code.id }, data: { usedAt: new Date() } });
        const grant = await tx.aiExternalGrant.create({ data: { workspaceId: code.workspaceId, userId: code.userId, clientId: client.id, scopes: code.scopes as string[], toolIds: code.toolIds as string[], tokenFingerprint: sha(access), refreshFingerprint: sha(refresh), accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS), expiresAt: new Date(Date.now() + GRANT_DAYS * 86400000) } });
        await emitEvent(tx, { workspaceId: code.workspaceId, eventType: 'AI_EXTERNAL_CONNECTION_GRANTED', aggregateType: 'AiExternalGrant', aggregateId: grant.id, actorId: code.userId, payload: { clientId: client.id } });
        grantId = grant.id;
      } else {
        const grant = await tx.aiExternalGrant.findUnique({ where: { refreshFingerprint: sha(input.refresh_token) } });
        if (!grant || grant.clientId !== client.id || grant.revokedAt || grant.expiresAt <= new Date()) throw invalid;
        // Rotation: the old refresh token stops working immediately.
        await tx.aiExternalGrant.update({ where: { id: grant.id }, data: { tokenFingerprint: sha(access), refreshFingerprint: sha(refresh), accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS), version: { increment: 1 } } });
        grantId = grant.id;
      }
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, grant_id: grantId };
    });
  }
  /** Every MCP call re-resolves: active client + unexpired, unrevoked grant + live membership + permission + entitlement (08 rule 2). */
  private async session(authorization: string | null) {
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
    const grant = token ? await this.db.aiExternalGrant.findUnique({ where: { tokenFingerprint: sha(token) } }) : null;
    if (!grant || grant.revokedAt || grant.expiresAt <= new Date() || !grant.accessExpiresAt || grant.accessExpiresAt <= new Date()) throw new AppError('UNAUTHENTICATED', 'MCP grant is invalid, expired or revoked.', 401);
    const client = await this.db.aiExternalClient.findUnique({ where: { id: grant.clientId } });
    if (!client || client.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED', 'MCP client is revoked.', 401);
    const actor = await resolvePrincipal(this.db, grant.workspaceId, grant.userId);
    entitled(actor, 'ai');
    const capability = sha(JSON.stringify([grant.scopes, grant.toolIds]));
    await this.db.aiExternalSession.upsert({ where: { grantId_capabilityHash: { grantId: grant.id, capabilityHash: capability } }, create: { grantId: grant.id, capabilityHash: capability }, update: { lastSeenAt: new Date() } });
    return { grant, actor };
  }
  /** Inventory filtered by grant scope AND the user's live permissions; forbidden tools are never named (08 AC02). */
  async listTools(authorization: string | null) {
    const { grant, actor } = await this.session(authorization);
    if (!(grant.scopes as string[]).includes('tools:read')) throw new AppError('PERMISSION_DENIED', 'Scope tools:read is required.', 403);
    return allTools().filter(t => (grant.toolIds as string[]).includes(t.code) && actor.grants.has(t.requiredPermission)).map(t => ({ name: t.code, risk: t.risk, description: t.description }));
  }
  /**
   * Arguments can't carry tenant authority: workspace/user come only from the grant (08 AC03). READ tools execute; writes create a
   * pending tool call that the user must approve in-app with the exact arguments hash (08 AC04).
   */
  async executeTool(authorization: string | null, raw: unknown) {
    const { grant, actor } = await this.session(authorization);
    if (!(grant.scopes as string[]).includes('tools:invoke')) throw new AppError('PERMISSION_DENIED', 'Scope tools:invoke is required.', 403);
    const input = z.strictObject({ toolName: z.string().max(80), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(raw);
    const tool = toolByCode(input.toolName);
    if (!tool || !(grant.toolIds as string[]).includes(tool.code) || !actor.grants.has(tool.requiredPermission)) throw notFound('Tool');
    const args = tool.input.parse(input.arguments) as Record<string, unknown>;
    if (Object.keys(input.arguments).some(k => /workspace|tenant|userId|actor/i.test(k))) throw new AppError('VALIDATION_FAILED', 'Arguments cannot carry tenant or identity fields.', 400);
    const run = await this.db.aiRun.create({ data: { workspaceId: actor.workspaceId, requesterId: actor.userId, scenarioCode: 'mcp.tool', scenarioVersion: 1, status: tool.risk === 'READ' ? 'RUNNING' : 'WAITING_APPROVAL', inputHash: sha(JSON.stringify(input)), idempotencyKey: 'mcp:' + randomUUID() } });
    const argsHash = createHash('sha256').update(JSON.stringify({ code: tool.code, version: tool.version, args })).digest('hex');
    const call = await this.db.aiToolCall.create({ data: { runId: run.id, workspaceId: actor.workspaceId, callIndex: 0, toolCode: tool.code, toolVersion: tool.version, argumentsSealed: encrypt(JSON.stringify(args)), argsHash, targetRef: tool.target(args),
      status: tool.risk === 'READ' ? 'PROPOSED' : 'WAITING_APPROVAL', correlationId: randomUUID(), expiresAt: new Date(Date.now() + 24 * 3600000) } });
    await this.db.$transaction(tx => emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_MCP_TOOL_INVOKED', aggregateType: 'AiToolCall', aggregateId: call.id, actorId: actor.userId, payload: { tool: tool.code, clientId: grant.clientId, risk: tool.risk } }));
    if (tool.risk !== 'READ') return { status: 'WAITING_APPROVAL', runId: run.id, toolCallId: call.id, argumentsHash: argsHash, approveIn: '/api/v1/ai/runs/' + run.id + '/tool-calls/' + call.id + '/approve' };
    const result = await executeToolCall(this.db, call.id, null);
    await this.db.aiRun.update({ where: { id: run.id }, data: { status: result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date(), errorCode: result.errorCode } });
    return { status: result.status, result: result.result, errorCode: result.errorCode };
  }
  async myGrants(actor: Principal) {
    return this.db.aiExternalGrant.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { createdAt: 'desc' }, select: { id: true, clientId: true, scopes: true, toolIds: true, expiresAt: true, revokedAt: true, createdAt: true } });
  }
  /** Revocation is immediate: token fingerprints are re-checked on every request (08 AC01/AC05). */
  async revokeGrant(actor: Principal, id: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const grant = await tx.aiExternalGrant.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!grant) throw notFound('Grant');
      if (grant.userId !== actor.userId) requirePermission(actor, 'ai.mcp.manage');
      await tx.aiExternalGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), tokenFingerprint: null, refreshFingerprint: null, version: { increment: 1 } } });
      await tx.aiExternalSession.updateMany({ where: { grantId: grant.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_EXTERNAL_CONNECTION_REVOKED', resourceType: 'AiExternalGrant', resourceId: grant.id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_EXTERNAL_CONNECTION_REVOKED', aggregateType: 'AiExternalGrant', aggregateId: grant.id, actorId: actor.userId, payload: {} });
      return { id: grant.id, revoked: true };
    });
  }
}
