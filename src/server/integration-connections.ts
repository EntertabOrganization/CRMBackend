import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AppError } from './errors';
import type { SecretPort } from './ports';
import { assertSafeUrlShape, isPrivateAddress } from './automation/egress';
import { evidence, requirePermission, type Principal, type Tx } from './process-platform/context';
import { parse, uuid, name } from './process-platform/dto';

/** Compatible with the platform SecretPort; deployment resolves tenant-scoped secret references from its environment. */
export class EnvironmentSecretPort implements SecretPort {
  resolve(workspaceId: string, reference: string) {
    const key = 'TRUECRM_SECRET_' + createHash('sha256').update(workspaceId + ':' + reference).digest('hex').toUpperCase();
    return process.env[key] ?? null;
  }
}
const connectionInput = z.strictObject({ name, baseUrl: z.string().max(2000), allowedHosts: z.array(z.string().max(253)).min(1).max(20),
  secretReference: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional(),supportsIdempotency: z.boolean().default(false) });
const blocked = () => new AppError('WORKFLOW_HTTP_DESTINATION_BLOCKED','Outbound destination is unavailable.',422);

/** Owning shared Integration authority. HTTP is pinned to the DNS addresses checked for this request. */
export class IntegrationConnectionService {
  constructor(private readonly db: PrismaClient, private readonly secrets: SecretPort = new EnvironmentSecretPort(),
    private readonly resolveAddresses = async (host: string) => (await lookup(host,{ all: true })).map(a => ({ address: a.address, family: a.family }))) {}
  async create(actor: Principal, raw: unknown) {
    requirePermission(actor,'INTEGRATION.CONNECTION_MANAGE',true); const input = parse(connectionInput,raw);
    let url: URL; try { url = assertSafeUrlShape(input.baseUrl,{ allowHttp: false }); } catch { throw blocked(); }
    const hosts = input.allowedHosts.map(host => host.toLowerCase());
    if (hosts.some(host => !/^[a-z0-9.-]+$/.test(host) || host.includes('..')) || !hosts.includes(url.hostname)) throw blocked();
    await this.assertResolved(url);
    return this.db.$transaction(async tx => {
      const row = await tx.integrationOutboundConnection.create({ data: { workspaceId: actor.workspaceId, createdByUserId: actor.userId,
        ...input, baseUrl: url.toString(), allowedHosts: hosts } });
      await evidence(tx,actor,'INTEGRATION_CONNECTION',row.id,'INTEGRATION_CONNECTION_CREATED',{ name: row.name, allowedHosts: hosts });
      return { id: row.id, name: row.name, baseUrl: row.baseUrl, allowedHosts: row.allowedHosts, version: row.version, isActive: row.isActive };
    });
  }
  async destination(tx: Tx, actor: Principal, connectionId: string, path: string) {
    requirePermission(actor,'INTEGRATION.CONNECTION_USE');
    parse(uuid,connectionId);
    const row = await tx.integrationOutboundConnection.findFirst({ where: { workspaceId: actor.workspaceId, id: connectionId, isActive: true } });
    if (!row) throw new AppError('WORKFLOW_CONNECTION_NOT_FOUND','Connection is unavailable.',404);
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\x00-\x20]/.test(path)) throw blocked();
    let url: URL;
    try { url = assertSafeUrlShape(new URL(path,row.baseUrl).toString(),{ allowHttp: false }); } catch { throw blocked(); }
    const allowed = parse(z.array(z.string()),row.allowedHosts);
    if (!allowed.includes(url.hostname)) throw blocked();
    await this.assertResolved(url);
    return { row,url,allowed };
  }
  private async assertResolved(url: URL) {
    const host = url.hostname.replace(/^\[|\]$/g,'');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolveAddresses(host).catch(() => { throw blocked(); });
    if (!addresses.length || addresses.some(address => isPrivateAddress(address.address))) throw blocked();
    return addresses;
  }
  async prepare(tx: Tx, actor: Principal, connectionId: string, path: string) {
    const { row,url,allowed } = await this.destination(tx,actor,connectionId,path);
    const secret = row.secretReference ? this.secrets.resolve(actor.workspaceId,row.secretReference) : null;
    if (row.secretReference && !secret) throw new AppError('WORKFLOW_CONNECTION_NOT_FOUND','Connection credential is unavailable.',503);
    return { url,allowed,secret,supportsIdempotency: row.supportsIdempotency };
  }
  async send(tx: Tx, actor: Principal, connectionId: string, path: string, method: string, body: unknown, timeoutMs: number, effectKey: string) {
    return this.sendPrepared(await this.prepare(tx,actor,connectionId,path),method,body,timeoutMs,effectKey);
  }
  async sendPrepared(prepared: Awaited<ReturnType<IntegrationConnectionService['prepare']>>, method: string, body: unknown, timeoutMs: number, effectKey: string) {
    const { url,allowed,secret } = prepared;
    let target = url, currentMethod = method, payload = JSON.stringify(body), forwardCredential = true;
    for (let redirects = 0; redirects <= 3; redirects++) {
      let safe: URL; try { safe = assertSafeUrlShape(target.toString(),{ allowHttp: false }); } catch { throw blocked(); }
      if (!allowed.includes(safe.hostname)) throw blocked();
      const addresses = await this.assertResolved(safe), pinned = addresses[0];
      const response = await new Promise<{ status: number; location?: string; body: Buffer }>((resolve,reject) => {
        const req = httpsRequest(safe,{ method: currentMethod, timeout: timeoutMs,
          lookup: (_hostname,_options,callback) => callback(null,pinned.address,pinned.family),
          headers: { 'content-type': 'application/json', 'idempotency-key': effectKey,
            ...(secret && forwardCredential ? { authorization: 'Bearer ' + secret } : {}) } },res => {
          const chunks: Buffer[] = []; let bytes = 0;
          res.on('data',(chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) req.destroy(new Error('limit')); else chunks.push(chunk); });
          res.on('error',() => reject(new AppError('WORKFLOW_NODE_FAILED','Outbound response failed.',503)));
          res.on('end',() => resolve({ status: res.statusCode ?? 502, location: res.headers.location, body: Buffer.concat(chunks) }));
        });
        req.on('timeout',() => req.destroy(new Error('timeout')));
        req.on('error',() => reject(new AppError('WORKFLOW_NODE_FAILED','Outbound request failed.',503)));
        if (!['GET','HEAD'].includes(currentMethod)) req.write(payload); req.end();
      });
      if ([301,302,303,307,308].includes(response.status)) {
        if (!response.location || redirects === 3) throw blocked();
        const next = new URL(response.location,safe);
        if (next.origin !== url.origin) forwardCredential = false;
        if (response.status === 303 || [301,302].includes(response.status) && currentMethod === 'POST') { currentMethod = 'GET'; payload = ''; }
        target = next; continue;
      }
      if (response.status === 429 || response.status >= 500) throw new AppError('WORKFLOW_NODE_FAILED','Provider requested a retry.',503);
      if (response.status < 200 || response.status >= 400) throw new AppError('WORKFLOW_NODE_FAILED','Provider rejected the request.',422);
      // Raw response content may contain credentials; retain only safe outcome metadata.
      return { httpStatus: response.status, responseBytes: response.body.length };
    }
    throw blocked();
  }
}
