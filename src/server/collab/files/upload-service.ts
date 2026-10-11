import { createHash } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError, isAppError } from '../../errors';
import { Body, type CollabSupport, fingerprint } from '../support';
import type { DriveFile, DriveFileVersion, UploadSession } from './types';
import type { FileService } from './file-service';
import type { ProjectDriveService } from './project-drive-service';
import { LocalObjectStorage, assertProcessingResult, type ObjectStorage, type FileContentProcessor, type ProcessingResult } from './object-storage';
import { EnvironmentContentProcessor } from './content-processor';
import type { DocumentEditSession } from './editing-types';

export class UploadService {
  private objects: ObjectStorage = new LocalObjectStorage();
  private processor: FileContentProcessor = new EnvironmentContentProcessor();
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService, private readonly files: FileService) {}
  configure(objects: ObjectStorage, processor: FileContentProcessor) { this.objects = objects; this.processor = processor; }
  objectStorage() { return this.objects; }
  contentProcessor() { return this.processor; }
  private get state() { return this.support.state; }
  private safe(row: UploadSession) {
    const { fingerprint, parts, purgedAt, cleanupClaimId, cleanupLeaseExpiresAt, cleanupNextAttemptAt, cleanupAttempts, cleanupErrorCode, cleanedAt,
      processingClaimId, processingLeaseExpiresAt, processingNextAttemptAt, processingAttempts, processingErrorCode, ...safe } = row;
    return { ...safe, parts: parts.map(({ objectKey, ...part }) => part) };
  }
  private authority(actor: ActorContext, id: string, active = false, editId?: string) {
    if (!this.support.access.scopeFor(actor, 'file.create') && !this.support.access.scopeFor(actor, 'file.version_create') && !this.support.access.scopeFor(actor, 'file.edit')) this.support.require(actor, 'file.create');
    const row = this.state.uploadSessions.find(row => row.id === id && row.workspaceId === actor.workspaceId && row.createdByUserId === actor.user.id && !row.purgedAt);
    if (!row) throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Upload Session was not found.', 404);
    const edit = row.editSessionId ? this.state.documentEditSessions.find(edit => edit.id === row.editSessionId && edit.workspaceId === actor.workspaceId && edit.userId === actor.user.id && edit.fileId === row.targetFileId) : null;
    if (row.editSessionId && (!edit || editId !== edit.id)) throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Upload Session was not found.', 404);
    if (active && edit && (edit.status !== 'ACTIVE' || !edit.providerReady || edit.expiresAt <= this.support.now())) throw new AppError('EDIT_SESSION_EXPIRED', 'The edit session is no longer active.', 410);
    if (row.targetFileId) {
      const file = this.storages.fileAuthority(actor, row.targetFileId, edit ? 'file.edit' : 'file.version_create', 3, !active, active);
      if (active) {
        this.files.assertUnlocked(actor.workspaceId, [file.id], edit?.lockId ?? undefined);
        if (edit && file.currentVersionId !== edit.baseVersionId) throw new AppError('RESOURCE_VERSION_CONFLICT', 'The edited source Version has changed.', 409);
      }
      if (active && file.folderId !== row.targetFolderId) throw new AppError('UPLOAD_SESSION_TARGET_CHANGED', 'The target File has moved.', 409);
    } else this.storages.folderAuthority(actor, row.targetFolderId, 'file.create', 2, false, active);
    if (active && row.expiresAt <= this.support.now()) throw new AppError('UPLOAD_SESSION_EXPIRED', 'Upload Session has expired.', 410);
    return row;
  }
  private record(actor: ActorContext, row: UploadSession, action: string) {
    this.support.audit(actor, row.workspaceId, `UPLOAD.${action}`, 'UPLOAD_SESSION', row.id, null, this.safe(row));
    this.support.event({ workspaceId: row.workspaceId, type: `UPLOAD_${action}`, entityType: 'UPLOAD_SESSION', entityId: row.id,
      actorUserId: actor.user.id, changes: { status: row.status, resultFileId: row.resultFileId, resultVersionId: row.resultVersionId } });
  }
  create(actor: ActorContext, body: Body, idempotencyKey?: string, edit?: DocumentEditSession) {
    body.only(['targetFolderId', 'desiredFileName', 'expectedSizeBytes', 'expectedChecksum', 'mimeType', 'conflictMode', 'fileId', 'idempotencyKey', 'version']);
    const folderId = body.uuid('targetFolderId', { required: true });
    const targetFileId = body.uuid('fileId') ?? null;
    if (edit && (edit.workspaceId !== actor.workspaceId || edit.userId !== actor.user.id || edit.fileId !== targetFileId || edit.status !== 'ACTIVE' || !edit.providerReady || edit.expiresAt <= this.support.now())) throw new AppError('EDIT_SESSION_EXPIRED', 'The edit session is no longer active.', 410);
    const target = targetFileId ? this.storages.fileAuthority(actor, targetFileId, edit ? 'file.edit' : 'file.version_create', 3, false, true) : undefined;
    if (target) this.files.assertUnlocked(actor.workspaceId, [target.id], edit?.lockId ?? undefined);
    const folder = target ? this.state.fileFolders.find(folder => folder.id === folderId && folder.workspaceId === actor.workspaceId && folder.storageId === target.storageId) : this.storages.folderAuthority(actor, folderId, 'file.create', 2);
    if (!folder) throw new AppError('UPLOAD_SESSION_TARGET_CHANGED', 'Version upload must target the current File location.', 409);
    const desiredFileName = body.str('desiredFileName', { required: true, max: 500 }).normalize('NFC');
    const expectedSizeBytes = body.int('expectedSizeBytes', { required: true, min: 0, max: Number.MAX_SAFE_INTEGER });
    const expectedChecksum = body.str('expectedChecksum', { required: true, max: 64 });
    if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Supply a SHA-256 checksum in lowercase hexadecimal.', 400);
    const mimeType = body.str('mimeType', { required: true, max: 200 });
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new AppError('VALIDATION_ERROR', 'Supply a valid MIME type.', 400);
    const conflictMode = body.enumOf('conflictMode', ['CREATE_VERSION', 'RENAME', 'CANCEL'] as const) ?? null;
    if (targetFileId) {
      const file = this.storages.fileAuthority(actor, targetFileId, edit ? 'file.edit' : 'file.version_create', 3, false, true);
      if (file.folderId !== folder.id || file.name !== desiredFileName || conflictMode !== 'CREATE_VERSION') throw new AppError('UPLOAD_SESSION_TARGET_CHANGED', 'Version upload must target the current File location and name.', 409);
    }
    const key = (body.str('idempotencyKey', { max: 200, min: 1 }) ?? idempotencyKey)?.trim();
    if (!key || key.length > 200) throw new AppError('VALIDATION_ERROR', 'Supply an idempotency key of 1 to 200 characters.', 400);
    const signature = fingerprint({ folderId, desiredFileName, expectedSizeBytes, expectedChecksum, mimeType, conflictMode, targetFileId, ...(edit ? { editSessionId: edit.id } : {}) });
    const existing = this.state.uploadSessions.find(row => row.workspaceId === actor.workspaceId && row.createdByUserId === actor.user.id && row.idempotencyKey === key);
    if (existing) {
      if (existing.purgedAt) throw new AppError('UPLOAD_SESSION_PURGED', 'The original upload has been permanently removed.', 410);
      if (existing.fingerprint !== signature) throw new AppError('UPLOAD_IDEMPOTENCY_CONFLICT', 'This key was used for another upload.', 409);
      return this.safe(existing);
    }
    if (targetFileId) this.support.expectVersion(this.state.driveFiles.find(file => file.id === targetFileId)!, body.raw.version);
    this.files.quota(actor.workspaceId, expectedSizeBytes, expectedSizeBytes);
    const now = this.support.now(), row: UploadSession = { id: this.support.id(), workspaceId: actor.workspaceId, createdByUserId: actor.user.id,
      targetFolderId: folderId, desiredFileName, expectedSizeBytes, expectedChecksum, mimeType, conflictMode, targetFileId, editSessionId: edit?.id ?? null,
      status: 'CREATED', idempotencyKey: key, fingerprint: signature, parts: [], expiresAt: new Date(now.getTime() + 86400000),
      resultFileId: null, resultVersionId: null, version: 1, createdAt: now, updatedAt: now,
      cleanupClaimId: null, cleanupLeaseExpiresAt: null, cleanupNextAttemptAt: null, cleanupAttempts: 0, cleanupErrorCode: null, cleanedAt: null,
      processingClaimId: null, processingLeaseExpiresAt: null, processingNextAttemptAt: null, processingAttempts: 0, processingErrorCode: null };
    this.state.uploadSessions.push(row); this.record(actor, row, 'CREATED'); return this.safe(row);
  }
  createVersion(actor: ActorContext, id: string, body: Body, idempotencyKey?: string) {
    body.only(['expectedSizeBytes', 'expectedChecksum', 'mimeType', 'idempotencyKey', 'version']);
    const file = this.storages.fileAuthority(actor, id, 'file.version_create', 3, false, true);
    return this.create(actor, new Body({ ...body.raw, targetFolderId: file.folderId, desiredFileName: file.name, fileId: id, conflictMode: 'CREATE_VERSION' }), idempotencyKey);
  }
  createForEdit(actor: ActorContext, edit: DocumentEditSession, checksum: string, size: number, mimeType: string) {
    const file = this.storages.fileAuthority(actor, edit.fileId, 'file.edit', 3, false, true);
    return this.create(actor, new Body({ targetFolderId: file.folderId, desiredFileName: file.name, fileId: file.id,
      conflictMode: 'CREATE_VERSION', expectedChecksum: checksum, expectedSizeBytes: size, mimeType, version: file.version }), `document-edit:${edit.id}`, edit);
  }
  get(actor: ActorContext, id: string) { return this.safe(this.authority(actor, id)); }
  async part(actor: ActorContext, id: string, body: Body, editId?: string) {
    body.only(['partNumber', 'dataBase64', 'checksum']); const row = this.authority(actor, id, true, editId);
    if (!['CREATED', 'UPLOADING'].includes(row.status)) throw new AppError('UPLOAD_SESSION_STATE_INVALID', 'This upload no longer accepts parts.', 409);
    const partNumber = body.int('partNumber', { required: true, min: 1, max: 100 });
    const encoded = body.str('dataBase64', { required: true, trim: false, max: 5592408 });
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new AppError('UPLOAD_PART_INVALID', 'Parts must be canonical base64 and at most 4 MiB.', 400);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (body.str('checksum', { required: true, max: 64 }) !== checksum) throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Part checksum differs.', 409);
    const existing = row.parts.find(part => part.partNumber === partNumber);
    if (existing) {
      if (existing.checksum !== checksum || existing.sizeBytes !== bytes.length) throw new AppError('UPLOAD_PART_CONFLICT', 'A different immutable part already uses this number.', 409);
      return this.safe(row);
    }
    if (row.parts.reduce((sum, part) => sum + part.sizeBytes, 0) + bytes.length > row.expectedSizeBytes) throw new AppError('UPLOAD_PART_INVALID', 'Parts exceed the declared upload size.', 409);
    const objectKey = `${row.workspaceId}/uploads/${id}/parts/${partNumber}/${checksum}`;
    await this.objects.putImmutable(objectKey, bytes);
    row.parts.push({ partNumber, checksum, sizeBytes: bytes.length, objectKey }); row.parts.sort((a, b) => a.partNumber - b.partNumber);
    row.status = 'UPLOADING'; this.support.touch(row); this.record(actor, row, 'PART_ACCEPTED'); return this.safe(row);
  }
  async complete(actor: ActorContext, id: string, body: Body, editId?: string) {
    body.only([]); const row = this.authority(actor, id, false, editId);
    if (row.status === 'COMPLETED' || row.status === 'PROCESSING') return this.safe(row);
    this.authority(actor, id, true, editId);
    if (!['CREATED', 'UPLOADING', 'PROCESSING'].includes(row.status)) throw new AppError('UPLOAD_SESSION_STATE_INVALID', 'This upload cannot be completed.', 409);
    if (row.parts.some((part, index) => part.partNumber !== index + 1)) throw new AppError('UPLOAD_PART_INVALID', 'Upload parts must be contiguous starting at one.', 409);
    const bytes = Buffer.concat(await Promise.all(row.parts.map(async part => {
      const value = await this.objects.read(part.objectKey);
      if (value.length !== part.sizeBytes || createHash('sha256').update(value).digest('hex') !== part.checksum) throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Stored part content differs.', 409);
      return value;
    })));
    if (bytes.length !== row.expectedSizeBytes || createHash('sha256').update(bytes).digest('hex') !== row.expectedChecksum) throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Complete content differs from the declared size/checksum.', 409);
    this.files.quota(actor.workspaceId, row.resultVersionId ? 0 : bytes.length, bytes.length, row.id);
    const folder = row.targetFileId ? this.state.fileFolders.find(folder => folder.id === row.targetFolderId && folder.workspaceId === row.workspaceId)! : this.storages.folderAuthority(actor, row.targetFolderId, 'file.create', 2);
    const edit = row.editSessionId ? this.state.documentEditSessions.find(edit => edit.id === row.editSessionId && edit.workspaceId === row.workspaceId) : undefined;
    let file = row.resultFileId ? this.state.driveFiles.find(file => file.id === row.resultFileId && file.workspaceId === row.workspaceId) : row.targetFileId ? this.storages.fileAuthority(actor, row.targetFileId, edit ? 'file.edit' : 'file.version_create', 3, false, true) : undefined;
    if (file && file.folderId !== folder.id) throw new AppError('UPLOAD_SESSION_TARGET_CHANGED', 'The target File has moved.', 409);
    const sibling = this.state.driveFiles.find(file => file.workspaceId === row.workspaceId && file.folderId === folder.id && file.status !== 'TRASHED' && file.name.trim().normalize('NFC').toLowerCase() === row.desiredFileName.trim().normalize('NFC').toLowerCase());
    let name = row.desiredFileName;
    if (!file && sibling) {
      if (row.conflictMode === 'CREATE_VERSION') file = this.storages.fileAuthority(actor, sibling.id, 'file.version_create', 3, false, true);
      else if (row.conflictMode === 'RENAME') { name = `${name.slice(0, 450)} (${row.id})`; }
      else throw new AppError('FILE_NAME_CONFLICT', 'Choose an explicit rename or new-Version conflict mode.', 409);
    }
    this.processor.assertConfigured?.();
    if (file) this.files.assertUnlocked(actor.workspaceId, [file.id], edit?.lockId ?? undefined);
    let outcome: { scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED'; processed: boolean }, processingError: string | null = null;
    try { outcome = await this.processor.process(Buffer.from(bytes), row.mimeType); assertProcessingResult(outcome); }
    catch (error) {
      outcome = { scanStatus: 'PENDING', processed: false };
      processingError = isAppError(error) ? error.code : 'FILE_PROCESSOR_UNAVAILABLE';
    }
    const objectKey = `${row.workspaceId}/objects/${id}/${row.expectedChecksum}`;
    await this.objects.putImmutable(objectKey, bytes);
    const now = this.support.now();
    if (!file) {
      const extension = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      file = { id: this.support.id(), workspaceId: row.workspaceId, storageId: folder.storageId, folderId: folder.id, name, extension, mimeType: row.mimeType,
        currentVersionId: null, status: 'PROCESSING', sizeBytesCurrent: 0, version: 1, publicShareVersion: 1, originalFolderId: null, statusBeforeTrash: null, trashedAt: null, purgeAfter: null, createdAt: now, updatedAt: now };
      this.state.driveFiles.push(file);
      this.support.event({ workspaceId: row.workspaceId, type: 'FILE_CREATED', entityType: 'FILE', entityId: file.id, actorUserId: actor.user.id, changes: { folderId: folder.id, uploadSessionId: row.id } });
      this.support.audit(actor, row.workspaceId, 'FILE.CREATED', 'FILE', file.id, null, { name, folderId: folder.id, uploadSessionId: row.id });
    }
    let version = row.resultVersionId ? this.state.driveFileVersions.find(version => version.id === row.resultVersionId && version.fileId === file!.id) : undefined;
    if (row.resultVersionId && !version) throw new AppError('UPLOAD_SESSION_STATE_INVALID', 'Completed content is no longer available.', 409);
    if (!version) {
      const number = this.state.driveFileVersions.filter(version => version.fileId === file!.id).reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
      if (number > 2147483647) throw new AppError('FILE_VERSION_LIMIT', 'File Version limit reached.', 409);
      version = { id: this.support.id(), workspaceId: row.workspaceId, fileId: file.id, versionNumber: number, objectKey, sizeBytes: bytes.length,
        checksum: row.expectedChecksum, mimeType: row.mimeType, createdByUserId: actor.user.id, createdAt: now, processedAt: outcome.processed ? now : null, scanStatus: outcome.scanStatus };
      this.state.driveFileVersions.push(version); file.currentVersionId = version.id;
      file.sizeBytesCurrent = version.sizeBytes; file.mimeType = version.mimeType;
      this.support.event({ workspaceId: row.workspaceId, type: 'FILE_VERSION_CREATED', entityType: 'FILE', entityId: file.id, actorUserId: actor.user.id, changes: { versionId: version.id } });
      this.support.audit(actor, row.workspaceId, 'FILE.VERSION_CREATED', 'FILE', file.id, null, { versionId: version.id, versionNumber: number, checksum: version.checksum, sizeBytes: version.sizeBytes, scanStatus: version.scanStatus });
    }
    row.resultFileId = file.id; row.resultVersionId = version.id;
    this.applyProcessing(row, outcome, now, actor);
    row.processingErrorCode = processingError;
    return this.safe(row);
  }
  /** Trusted worker transition: immutable Version identity is unchanged and all shared aliases move together. */
  applyProcessing(row: UploadSession, outcome: { scanStatus: 'PENDING' | ProcessingResult['scanStatus']; processed: boolean }, now: Date, actor: ActorContext | null = null) {
    if (row.purgedAt) throw new AppError('UPLOAD_SESSION_NOT_FOUND', 'Upload Session was not found.', 404);
    const version = this.state.driveFileVersions.find(version => version.id === row.resultVersionId && version.workspaceId === row.workspaceId);
    if (!version) throw new AppError('UPLOAD_SESSION_STATE_INVALID', 'Accepted content is no longer available.', 409);
    const aliases = this.state.driveFileVersions.filter(alias => alias.workspaceId === row.workspaceId && alias.objectKey === version.objectKey);
    if (aliases.some(alias => alias.scanStatus === 'BLOCKED') && outcome.scanStatus !== 'BLOCKED') throw new AppError('FILE_BLOCKED', 'Blocked immutable content cannot be relabelled clean.', 409);
    for (const alias of aliases) { alias.scanStatus = outcome.scanStatus; if (outcome.processed && !alias.processedAt) alias.processedAt = now; }
    for (const current of this.state.driveFiles.filter(current => current.workspaceId === row.workspaceId && aliases.some(alias => alias.id === current.currentVersionId))) {
      const status = outcome.scanStatus === 'BLOCKED' ? 'BLOCKED' : outcome.processed ? 'ACTIVE' : 'PROCESSING';
      if (current.status !== 'TRASHED') current.status = status;
      else current.statusBeforeTrash = status;
      this.support.touch(current);
    }
    row.status = outcome.processed || outcome.scanStatus === 'BLOCKED' ? 'COMPLETED' : 'PROCESSING';
    row.processingClaimId = null; row.processingLeaseExpiresAt = null; row.processingErrorCode = null;
    row.processingNextAttemptAt = row.status === 'PROCESSING' ? new Date(now.getTime() + Math.min(60_000, 2000 * 2 ** Math.min(row.processingAttempts, 5))) : null;
    this.support.touch(row);
    const changes = { status: row.status, versionId: version.id, scanStatus: outcome.scanStatus, processed: outcome.processed };
    this.support.audit(actor, row.workspaceId, 'UPLOAD.PROCESSING_UPDATED', 'UPLOAD_SESSION', row.id, null, changes);
    this.support.event({ workspaceId: row.workspaceId, type: outcome.scanStatus === 'BLOCKED' ? 'FILE_BLOCKED' : outcome.processed ? 'FILE_PROCESSING_COMPLETED' : 'FILE_PROCESSING_PENDING', entityType: 'FILE', entityId: version.fileId, actorUserId: actor?.user.id ?? null, changes });
  }
  abort(actor: ActorContext, id: string, body: Body) {
    body.only([]); const row = this.authority(actor, id);
    if (row.resultVersionId) throw new AppError('UPLOAD_SESSION_STATE_INVALID', 'Accepted content must use File recycle operations.', 409);
    if (row.status === 'ABORTED') return this.safe(row);
    row.status = 'ABORTED'; this.support.touch(row); this.record(actor, row, 'ABORTED'); return this.safe(row);
  }
  /** System compensation only; a committed Version always retains its immutable object. */
  cancelEditUpload(edit: DocumentEditSession) {
    const row = this.state.uploadSessions.find(r => r.id === edit.uploadSessionId && r.editSessionId === edit.id && r.workspaceId === edit.workspaceId && r.createdByUserId === edit.userId);
    if (!row || row.resultVersionId) return;
    if (row.status !== 'ABORTED') { row.status = 'ABORTED'; this.support.touch(row); }
    const objectKey = `${row.workspaceId}/objects/${row.id}/${row.expectedChecksum}`, now = this.support.now();
    if (!this.state.fileObjectGarbage.some(r => r.workspaceId === row.workspaceId && r.objectKey === objectKey))
      this.state.fileObjectGarbage.push({ id: this.support.id(), workspaceId: row.workspaceId, objectKey, createdAt: now, updatedAt: now,
        claimId: null, leaseExpiresAt: null, nextAttemptAt: now, attempts: 0, errorCode: null, cleanedAt: null });
  }
}
