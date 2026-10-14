import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport } from '../support';
import type { ProjectDriveService } from './project-drive-service';
import type { ObjectStorage } from './object-storage';
import type { PublicLinkService } from './public-link-service';
import { defaultContentAuthority, type FileContentAuthority, type FileContentPurpose } from './content-authority';
export type FileDeliveryGrant = {
  id: string; workspaceId: string; fileId: string; versionId: string; userId: string; tokenHash: string;
  resourceShareVersion: number; expiresAt: Date; consumedAt: Date | null; createdAt: Date;
  publicLinkId: string | null; publicLinkVersion: number | null;
};
export class FileDeliveryService {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService,
    private readonly objects: () => ObjectStorage, private readonly bindings: (actor: ActorContext, fileId: string) => void | Promise<void>,
    private readonly publicLinks: PublicLinkService, private readonly authorizeContent: FileContentAuthority = defaultContentAuthority) {}
  private get state() { return this.support.state; }
  private unavailable(): never { throw new AppError('FILE_DELIVERY_UNAVAILABLE', 'This delivery path is unavailable.', 410); }
  private signature(id: string, nonce: string) {
    const secret = process.env.FILE_DELIVERY_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new AppError('FILE_DELIVERY_UNCONFIGURED', 'Configure a shared File delivery signing secret.', 503);
    return createHmac('sha256', secret).update(`file-delivery-v1:${id}:${nonce}`).digest('base64url');
  }
  private async content(actor: ActorContext, fileId: string, purpose: FileContentPurpose = 'DOWNLOAD') {
    const file = this.storages.fileAuthority(actor, fileId, 'file.download', 1);
    await this.bindings(actor, fileId);
    const version = this.state.driveFileVersions.find(row => row.workspaceId === actor.workspaceId && row.fileId === fileId && row.id === file.currentVersionId);
    if (file.status === 'BLOCKED' || version?.scanStatus === 'BLOCKED') throw new AppError('FILE_BLOCKED', 'Blocked content cannot be delivered.', 409);
    if (file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt) throw new AppError('FILE_QUARANTINED', 'Only clean processed content can be delivered.', 409);
    await this.authorizeContent(actor, version.objectKey, purpose);
    return { file, version };
  }
  issue(actor: ActorContext, fileId: string, query: URLSearchParams) {
    new Body(Object.fromEntries(query)).only([]);
    return this.grant(actor, fileId);
  }
  /** Owning-domain read for bounded background processing; the same content and binding authority applies. */
  async readForProcessing(actor: ActorContext, fileId: string, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50_000_000)
      throw new AppError('FILE_TOO_LARGE', 'Invalid processing content limit.', 413);
    const { file, version } = await this.content(actor, fileId, 'PROCESS');
    if (version.sizeBytes > maxBytes) throw new AppError('FILE_TOO_LARGE', 'Source File exceeds the processing limit.', 413);
    const content = await this.objects().read(version.objectKey);
    if (content.byteLength > maxBytes) throw new AppError('FILE_TOO_LARGE', 'Source File exceeds the processing limit.', 413);
    if (content.length !== version.sizeBytes || createHash('sha256').update(content).digest('hex') !== version.checksum)
      throw new AppError('FILE_CONTENT_UNAVAILABLE', 'File content failed integrity verification.', 503);
    await this.authorizeContent(actor, version.objectKey, 'PROCESS');
    return { fileId: file.id, versionId: version.id, content, mimeType: version.mimeType, checksum: version.checksum };
  }
  async issuePublic(token: string, type: 'FILE' | 'FOLDER', query: URLSearchParams, password: string | null, clientKey = 'unknown') {
    new Body(Object.fromEntries(query)).only(type === 'FILE' ? [] : ['fileId']);
    const { row, actor, fileId } = await this.publicLinks.authorizeDownload(token, type, password, query.get('fileId') ?? undefined);
    return this.grant(actor, fileId, row, clientKey);
  }
  private async grant(actor: ActorContext, fileId: string, link?: { id: string; version: number; expiresAt: Date }, clientKey?: string) {
    const { file, version } = await this.content(actor, fileId, link ? 'PUBLIC' : 'DOWNLOAD'), id = this.support.id(), nonce = randomBytes(32).toString('base64url');
    const signature = this.signature(id, nonce), now = this.support.now(), expiresAt = new Date(Math.min(now.getTime() + 120_000, link?.expiresAt.getTime() ?? Infinity));
    if (expiresAt <= now) this.unavailable();
    this.state.fileDeliveryGrants.push({ id, workspaceId: actor.workspaceId, fileId, versionId: version.id, userId: actor.user.id,
      tokenHash: createHash('sha256').update(nonce).digest('hex'), resourceShareVersion: file.publicShareVersion, expiresAt, consumedAt: null, createdAt: now,
      publicLinkId: link?.id ?? null, publicLinkVersion: link?.version ?? null });
    const changes = { grantId: id, versionId: version.id, expiresAt, publicLinkId: link?.id ?? null };
    this.support.audit(link ? null : actor, actor.workspaceId, 'FILE.DELIVERY_AUTHORIZED', 'FILE', file.id, null, changes,
      link ? { clientHash: createHash('sha256').update(clientKey ?? 'unknown').digest('hex') } : null);
    this.support.event({ workspaceId: actor.workspaceId, type: 'FILE_DELIVERY_AUTHORIZED', entityType: 'FILE', entityId: file.id,
      actorUserId: link ? null : actor.user.id, changes });
    return { fileId, versionId: version.id, expiresAt, deliveryPath: `/api/v1/file-delivery/${id}?nonce=${nonce}&signature=${signature}` };
  }
  async redeem(id: string, query: URLSearchParams, clientKey: string) {
    new Body(Object.fromEntries(query)).only(['nonce', 'signature']);
    const nonce = query.get('nonce') ?? '', signature = query.get('signature') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) this.unavailable();
    if (!timingSafeEqual(Buffer.from(this.signature(id, nonce)), Buffer.from(signature))) this.unavailable();
    const grant = this.state.fileDeliveryGrants.find(row => row.id === id && row.tokenHash === createHash('sha256').update(nonce).digest('hex'));
    if (!grant || grant.consumedAt || grant.expiresAt <= this.support.now()) this.unavailable();
    const user = this.state.users.find(row => row.id === grant.userId);
    if (!user || !this.support.isEligibleUser(grant.workspaceId, user.id)) this.unavailable();
    let publicLink;
    if (grant.publicLinkId) publicLink = (await this.publicLinks.validateDelivery(grant.publicLinkId, grant.publicLinkVersion!, grant.workspaceId, grant.fileId)).row;
    let content;
    const actor = this.support.access.actor(user, grant.workspaceId);
    try { content = await this.content(actor, grant.fileId, grant.publicLinkId ? 'PUBLIC' : 'DOWNLOAD'); }
    catch { this.unavailable(); }
    const { file, version } = content;
    if (version.id !== grant.versionId || file.publicShareVersion !== grant.resourceShareVersion) this.unavailable();
    let bytes;
    try { bytes = await this.objects().read(version.objectKey); }
    catch { throw new AppError('FILE_CONTENT_UNAVAILABLE', 'File content is temporarily unavailable.', 503); }
    if (bytes.length !== version.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== version.checksum)
      throw new AppError('FILE_CONTENT_UNAVAILABLE', 'File content failed integrity verification.', 503);
    if (grant.expiresAt <= this.support.now()) this.unavailable();
    try { await this.authorizeContent(actor, version.objectKey, grant.publicLinkId ? 'PUBLIC' : 'DOWNLOAD'); }
    catch { this.unavailable(); }
    if (publicLink) this.publicLinks.consumeDownload(publicLink, clientKey);
    grant.consumedAt = this.support.now();
    const changes = { grantId: grant.id, versionId: version.id, sizeBytes: bytes.length, publicLinkId: grant.publicLinkId };
    this.support.audit(null, grant.workspaceId, 'FILE.DOWNLOADED', 'FILE', file.id, null, changes,
      { clientHash: createHash('sha256').update(clientKey).digest('hex') });
    this.support.event({ workspaceId: grant.workspaceId, type: 'FILE_DOWNLOADED', entityType: 'FILE', entityId: file.id,
      actorUserId: grant.publicLinkId ? null : user.id, changes });
    return { bytes, name: file.name, mimeType: version.mimeType };
  }
}
