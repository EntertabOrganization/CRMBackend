import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from 'argon2';
import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, isUuid, pageOf } from '../support';
import type { FilePublicLink, ProjectRootFolder } from './types';
import type { ProjectDriveService } from './project-drive-service';

/** Opaque, revocable public capabilities; no guest Workspace actor is synthesized. */
export class PublicLinkService {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService,
    private readonly privateBindings: (workspaceId: string, fileId: string) => boolean) {}
  private get state() { return this.support.state; }
  private missing(): never { throw new AppError('PUBLIC_LINK_NOT_FOUND', 'Public link was not found.', 404); }
  private disabled(code = 'PUBLIC_LINK_REVOKED'): never { throw new AppError(code, 'This public link is unavailable.', 410); }
  private safe(row: FilePublicLink) {
    const { tokenHash, passwordHash, ...safe } = row;
    return { ...safe, passwordProtected: Boolean(passwordHash) };
  }
  private policy(workspaceId: string) {
    const workspace = this.state.workspaces.find(row => row.id === workspaceId && !row.isDeleted);
    if (!workspace || workspace.settings.publicLinksEnabled === false) this.disabled();
    const maxDays = Number(workspace.settings.publicLinkMaxExpiryDays ?? 365);
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 3650) throw new AppError('PUBLIC_LINK_POLICY_INVALID', 'Public-link maximum expiry must be 1 to 3650 days.', 409);
    return maxDays;
  }
  private expiry(workspaceId: string, body: Body, previous?: Date) {
    const maxDays = this.policy(workspaceId), now = this.support.now();
    const expiresAt = body.has('expiresAt') ? body.instant('expiresAt', { required: true }) : previous ?? new Date(now.getTime() + Math.min(30, maxDays) * 86400000);
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + maxDays * 86400000) throw new AppError('PUBLIC_LINK_POLICY_INVALID', 'Expiry must be a future instant within the Workspace sharing policy.', 400);
    return expiresAt;
  }
  private manage(actor: ActorContext, id: string) {
    this.support.require(actor, 'file.public_link_manage');
    const row = this.state.filePublicLinks.find(row => row.id === id && row.workspaceId === actor.workspaceId);
    if (!row) this.missing();
    try { this.resource(actor, row.resourceType, row.resourceId, true); }
    catch (error) { if (error instanceof AppError && ['FOLDER_NOT_FOUND', 'FILE_NOT_FOUND'].includes(error.code)) this.missing(); throw error; }
    return row;
  }
  private resource(actor: ActorContext, type: FilePublicLink['resourceType'], id: string, trash = false) {
    return type === 'FILE' ? this.storages.fileAuthority(actor, id, 'file.public_link_manage', 4, trash, false)
      : this.storages.folderAuthority(actor, id, 'file.public_link_manage', 4, trash, false);
  }
  private publicContent(workspaceId: string, id: string) {
    const file = this.state.driveFiles.find(row => row.workspaceId === workspaceId && row.id === id);
    const version = this.state.driveFileVersions.find(row => row.workspaceId === workspaceId && row.fileId === id && row.id === file?.currentVersionId);
    if (!file || file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt) this.disabled();
    // Anonymous access cannot satisfy private owning-record authority. Binding removal is required before public sharing.
    if (this.privateBindings(workspaceId, id)) this.disabled();
    return { id: file.id, name: file.name, mimeType: version.mimeType, sizeBytes: version.sizeBytes,
      currentVersionId: version.id, version: file.version };
  }
  private record(actor: ActorContext | null, row: FilePublicLink, action: string, before: unknown = null, metadata: unknown = null) {
    this.support.audit(actor, row.workspaceId, `PUBLIC_LINK.${action}`, 'FILE_PUBLIC_LINK', row.id, before, this.safe(row), metadata);
    this.support.event({ workspaceId: row.workspaceId, type: `PUBLIC_LINK_${action}`, entityType: 'FILE_PUBLIC_LINK', entityId: row.id,
      actorUserId: actor?.user.id ?? null, changes: { resourceType: row.resourceType, resourceId: row.resourceId, version: row.version } });
  }
  async createFolder(actor: ActorContext, id: string, body: Body) {
    return this.create(actor, 'FOLDER', id, body);
  }
  async createFile(actor: ActorContext, id: string, body: Body) {
    return this.create(actor, 'FILE', id, body);
  }
  private async create(actor: ActorContext, resourceType: FilePublicLink['resourceType'], id: string, body: Body) {
    body.only(['permissionMode', 'password', 'expiresAt', 'maxDownloads', 'includeChildren']);
    const resource = this.resource(actor, resourceType, id);
    if (resourceType === 'FILE') this.publicContent(actor.workspaceId, id);
    const expiresAt = this.expiry(actor.workspaceId, body);
    const permissionMode = body.enumOf('permissionMode', ['VIEW', 'DOWNLOAD'] as const) ?? 'VIEW';
    const maxDownloads = body.int('maxDownloads', { min: 1, max: 1_000_000 }) ?? null;
    const includeChildren = body.bool('includeChildren') ?? false;
    if (resourceType === 'FILE' && includeChildren) throw new AppError('VALIDATION_ERROR', 'File links cannot include child resources.', 400);
    const password = body.str('password', { trim: false, min: 8, max: 256 });
    const token = randomBytes(32).toString('base64url'), now = this.support.now();
    const row: FilePublicLink = { id: this.support.id(), workspaceId: actor.workspaceId, resourceType, resourceId: id,
      tokenHash: createHash('sha256').update(token).digest('hex'), passwordHash: password ? await hash(password) : null,
      permissionMode, expiresAt, maxDownloads, includeChildren, isActive: true, downloadCount: 0, accessCount: 0,
      createdByUserId: actor.user.id, revokedAt: null, resourceShareVersion: resource.publicShareVersion ?? 1, version: 1, createdAt: now, updatedAt: now };
    this.state.filePublicLinks.push(row); this.record(actor, row, 'CREATED');
    return { ...this.safe(row), token, publicPath: `/api/v1/public/${resourceType === 'FILE' ? 'files' : 'folders'}/${token}` };
  }
  get(actor: ActorContext, id: string) { return this.safe(this.manage(actor, id)); }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'file.public_link_manage');
    const rows = this.state.filePublicLinks.filter(row => row.workspaceId === actor.workspaceId).filter(row => {
      try { this.manage(actor, row.id); return true; } catch (error) { if (error instanceof AppError && error.code === 'PUBLIC_LINK_NOT_FOUND') return false; throw error; }
    }).map(row => this.safe(row));
    return pageOf(rows, query, { searchable: [], filterable: ['resourceType', 'resourceId', 'isActive'], sortable: ['createdAt', 'expiresAt'], defaultSort: 'createdAt' });
  }
  async update(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['permissionMode', 'password', 'expiresAt', 'maxDownloads', 'includeChildren', 'isActive', 'version']);
    const row = this.manage(actor, id); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (body.raw.isActive === false) return this.revoke(actor, id, new Body({ version: row.version }));
    if (!row.isActive || row.revokedAt) this.disabled();
    const resource = this.resource(actor, row.resourceType, row.resourceId);
    if ((resource.publicShareVersion ?? 1) !== row.resourceShareVersion) this.disabled();
    if (row.resourceType === 'FILE') this.publicContent(actor.workspaceId, row.resourceId);
    const expiresAt = this.expiry(actor.workspaceId, body, row.expiresAt);
    const permissionMode = body.enumOf('permissionMode', ['VIEW', 'DOWNLOAD'] as const) ?? row.permissionMode;
    const includeChildren = body.bool('includeChildren') ?? row.includeChildren;
    if (row.resourceType === 'FILE' && includeChildren) throw new AppError('VALIDATION_ERROR', 'File links cannot include child resources.', 400);
    body.bool('isActive');
    const maxDownloads = body.has('maxDownloads') ? body.int('maxDownloads', { min: 1, max: 1_000_000 }) ?? null : row.maxDownloads;
    if (maxDownloads !== null && maxDownloads < row.downloadCount) throw new AppError('PUBLIC_LINK_DOWNLOAD_LIMIT', 'The new limit is below the recorded downloads.', 409);
    const password = body.has('password') ? body.str('password', { trim: false, min: 8, max: 256 }) : undefined;
    const passwordHash = password === undefined ? row.passwordHash : password === null ? null : await hash(password);
    const before = this.safe(row); Object.assign(row, { expiresAt, permissionMode, includeChildren, maxDownloads, passwordHash });
    this.support.touch(row); this.record(actor, row, 'UPDATED', before); return this.safe(row);
  }
  revoke(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only(['version']); const row = this.manage(actor, id); this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.revokedAt) return this.safe(row);
    const before = this.safe(row); row.isActive = false; row.revokedAt = this.support.now(); this.support.touch(row);
    this.record(actor, row, 'REVOKED', before); return this.safe(row);
  }
  private async resolve(token: string, type: FilePublicLink['resourceType'], password: string | null) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) this.missing();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.state.filePublicLinks.find(row => row.tokenHash === tokenHash);
    if (!row || row.resourceType !== type) this.missing();
    return this.validate(row, password);
  }
  private async validate(row: FilePublicLink, password?: string | null) {
    const type = row.resourceType;
    this.policy(row.workspaceId);
    if (!row.isActive || row.revokedAt) this.disabled();
    if (row.expiresAt <= this.support.now()) this.disabled('PUBLIC_LINK_EXPIRED');
    const root = (type === 'FILE' ? this.state.driveFiles : this.state.fileFolders).find(resource => resource.id === row.resourceId && resource.workspaceId === row.workspaceId);
    if (!root || (root.publicShareVersion ?? 1) !== row.resourceShareVersion) this.disabled();
    if (password !== undefined && row.passwordHash && (!password || password.length > 256 || !await verify(row.passwordHash, password))) throw new AppError('PUBLIC_LINK_PASSWORD_INVALID', 'A valid sharing password is required.', 403);
    const user = this.state.users.find(user => user.id === row.createdByUserId);
    if (!user || !this.support.isEligibleUser(row.workspaceId, user.id)) this.disabled();
    let actor: ActorContext;
    try { actor = this.support.access.actor(user, row.workspaceId); this.resource(actor, type, root.id); }
    catch { this.disabled(); }
    return { row, actor };
  }
  private downloadable(row: FilePublicLink, actor: ActorContext, fileId: string) {
    if (row.permissionMode !== 'DOWNLOAD') throw new AppError('PERMISSION_DENIED', 'This link does not permit downloads.', 403);
    if (row.downloadCount >= 2147483647 || row.maxDownloads !== null && row.downloadCount >= row.maxDownloads) this.disabled('PUBLIC_LINK_DOWNLOAD_LIMIT');
    try { this.storages.fileAuthority(actor, fileId, 'file.download', 1); } catch { this.disabled(); }
    this.publicContent(row.workspaceId, fileId);
    if (row.resourceType === 'FILE' && row.resourceId !== fileId) this.missing();
    if (row.resourceType === 'FOLDER') {
      const file = this.state.driveFiles.find(file => file.workspaceId === row.workspaceId && file.id === fileId)!;
      if (!this.tree(row, actor).has(file.folderId)) this.missing();
    }
    return { row, actor, fileId };
  }
  async authorizeDownload(token: string, type: FilePublicLink['resourceType'], password: string | null, fileId?: string) {
    const { row, actor } = await this.resolve(token, type, password);
    if (type === 'FOLDER' && !isUuid(fileId)) this.missing();
    return this.downloadable(row, actor, fileId ?? row.resourceId);
  }
  async validateDelivery(id: string, version: number, workspaceId: string, fileId: string) {
    const row = this.state.filePublicLinks.find(row => row.id === id && row.workspaceId === workspaceId && row.version === version);
    if (!row) this.disabled();
    const { actor } = await this.validate(row);
    return this.downloadable(row, actor, fileId);
  }
  consumeDownload(row: FilePublicLink, clientKey: string) {
    if (row.accessCount >= 2147483647) this.disabled('PUBLIC_LINK_ACCESS_LIMIT');
    if (row.expiresAt <= this.support.now()) this.disabled('PUBLIC_LINK_EXPIRED');
    if (row.maxDownloads !== null && row.downloadCount >= row.maxDownloads || row.downloadCount >= 2147483647) this.disabled('PUBLIC_LINK_DOWNLOAD_LIMIT');
    row.downloadCount += 1; this.accessed(row, clientKey);
    this.record(null, row, 'DOWNLOADED', null, { clientHash: createHash('sha256').update(clientKey).digest('hex') });
  }
  private accessed(row: FilePublicLink, clientKey: string) {
    if (row.accessCount >= 2147483647) throw new AppError('PUBLIC_LINK_ACCESS_LIMIT', 'This public link is unavailable.', 410);
    row.accessCount += 1; row.updatedAt = this.support.now();
    this.record(null, row, 'ACCESSED', null, { clientHash: createHash('sha256').update(clientKey).digest('hex') });
  }
  async publicFile(token: string, query: URLSearchParams, password: string | null, clientKey: string) {
    new Body(Object.fromEntries(query)).only([]);
    const { row } = await this.resolve(token, 'FILE', password);
    const file = this.publicContent(row.workspaceId, row.resourceId);
    this.accessed(row, clientKey);
    return { permissionMode: row.permissionMode, file };
  }
  async publicFolder(token: string, query: URLSearchParams, password: string | null, clientKey: string) {
    new Body(Object.fromEntries(query)).only(['folderId']);
    const { row, actor } = await this.resolve(token, 'FOLDER', password);
    const root = this.state.fileFolders.find(folder => folder.workspaceId === row.workspaceId && folder.id === row.resourceId)!;
    const folderId = query.get('folderId') ?? root.id;
    if (!isUuid(folderId) || folderId !== root.id && !row.includeChildren) this.missing();
    const authorized = this.tree(row, actor), folder = authorized.get(folderId); if (!folder) this.missing();
    const content = this.state.driveFiles.filter(file => file.workspaceId === row.workspaceId && file.folderId === folderId);
    if (content.length > 1000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Public folder reads support at most 1000 Files.', 409);
    const files = content.flatMap(file => {
      try { this.storages.fileAuthority(actor, file.id, 'file.public_link_manage', 1); return [{ ...this.publicContent(row.workspaceId, file.id),
        ...(row.permissionMode === 'DOWNLOAD' ? { downloadPath: `/api/v1/public/folders/${token}/download?fileId=${file.id}` } : {}) }]; }
      catch (error) { if (error instanceof AppError && ['FILE_NOT_FOUND', 'PUBLIC_LINK_REVOKED'].includes(error.code)) return []; throw error; }
    });
    this.accessed(row, clientKey);
    const safe = (folder: ProjectRootFolder) => ({ id: folder.id, name: folder.name, parentFolderId: folder.id === root.id ? null : folder.parentFolderId });
    return { permissionMode: row.permissionMode, folder: safe(folder), children: row.includeChildren ? [...authorized.values()].filter(child => child.parentFolderId === folder.id).map(safe) : [], files };
  }
  private tree(row: FilePublicLink, actor: ActorContext) {
    const root = this.state.fileFolders.find(folder => folder.workspaceId === row.workspaceId && folder.id === row.resourceId)!;
    // Reachability and issuer access are evaluated live. Moving a child out removes its capability.
    const authorized = new Map<string, ProjectRootFolder>(), pending = [root];
    while (pending.length) {
      const folder = pending.shift()!;
      if (authorized.has(folder.id)) this.disabled();
      try { this.storages.folderAuthority(actor, folder.id, 'file.public_link_manage', 1, false, false); } catch { continue; }
      if (authorized.size >= 1000) throw new AppError('FOLDER_GRAPH_LIMIT', 'Public trees support at most 1000 folders.', 409);
      authorized.set(folder.id, folder);
      if (row.includeChildren) pending.push(...this.state.fileFolders.filter(child => child.workspaceId === row.workspaceId && child.storageId === root.storageId && child.parentFolderId === folder.id && child.status === 'ACTIVE'));
    }
    return authorized;
  }
}
