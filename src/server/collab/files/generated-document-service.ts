import { createHash } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError, isAppError } from '../../errors';
import type { DeliveryOutcome, LeaseJobHandler } from '../../jobs/lease-runner';
import { Body, type CollabSupport, fingerprint, pageOf } from '../support';
import type { FileDeliveryService } from './delivery-service';
import { DOCX_MIME, PDF_MIME, blocksToDocx, blocksToPdf, escapeMarkup, htmlToBlocks, parseTemplate, readZip, renderDocx, renderNodes, type TemplateValue } from './document-render';
import type { DocumentTemplateService } from './document-template-service';
import { OUTPUT_FORMATS, type DocumentTemplateRevision, type GeneratedDocument } from './document-types';
import type { FileService } from './file-service';
import { assertProcessingResult } from './object-storage';
import type { ProjectDriveService } from './project-drive-service';
import type { DriveFile, DriveFileVersion } from './types';
import type { UploadService } from './upload-service';

const MAX_ATTEMPTS = 5, LEASE_MS = 300_000;
/** Failures that retrying cannot fix: they end the generation with a stable error code. */
const TERMINAL = new Set(['DOCUMENT_CONTEXT_ACCESS_DENIED', 'DOCUMENT_TEMPLATE_NOT_FOUND', 'DOCUMENT_TEMPLATE_INVALID', 'PERMISSION_DENIED', 'FOLDER_NOT_FOUND',
  'STORAGE_READ_ONLY', 'STORAGE_QUOTA_EXCEEDED', 'FILE_TOO_LARGE', 'FILE_QUOTA_POLICY_INVALID', 'FILE_BLOCKED', 'VALIDATION_ERROR', 'DOCUMENT_CREATOR_INACTIVE']);
type Ticket = { id: string; workspaceId: string; token: string; attempt: number; revision: DocumentTemplateRevision; values: Array<[string, TemplateValue]>;
  contextHash: string; outputFormat: GeneratedDocument['outputFormat']; title: string };
type Rendered = { objectKey: string; checksum: string; size: number; scanStatus: 'CLEAN' | 'BLOCKED'; processed: boolean };

/**
 * Generation runs as a leased job: requests commit QUEUED intent (202), rendering/scanning happen outside state units,
 * and publication re-proves the creator's live authority before a File/Version and its source attachment are committed.
 */
export class GeneratedDocumentService implements LeaseJobHandler<Ticket> {
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService, private readonly templates: DocumentTemplateService,
    private readonly files: FileService, private readonly uploads: UploadService, private readonly delivery: FileDeliveryService) {}
  private get state() { return this.support.state; }

  safe(row: GeneratedDocument) {
    const { requestHash, claimId, leaseExpiresAt, nextAttemptAt, inputs, ...rest } = row;
    return { ...rest, inputs: structuredClone(inputs) };
  }
  private document(actor: ActorContext, id: string) {
    const row = this.state.generatedDocuments.find(item => item.id === id && item.workspaceId === actor.workspaceId);
    if (!row) throw new AppError('GENERATED_DOCUMENT_NOT_FOUND', 'Generated document was not found.', 404);
    this.authorizeSource(actor, row.entityType, row.entityId);
    return row;
  }
  private authorizeSource(actor: ActorContext, entityType: string, entityId: string) {
    try { this.templates.adapter(entityType).read(actor, entityId); }
    catch { throw new AppError('DOCUMENT_CONTEXT_ACCESS_DENIED', 'The source record is inaccessible.', 403); }
  }

  get(actor: ActorContext, id: string) {
    this.support.require(actor, 'document.read');
    return this.safe(this.document(actor, id));
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'document.read');
    const archived = query.get('status') === 'ARCHIVED' || query.get('includeArchived') === 'true';
    const rows = this.state.generatedDocuments.filter(row => row.workspaceId === actor.workspaceId && (archived || row.status !== 'ARCHIVED')).filter(row => {
      try { this.authorizeSource(actor, row.entityType, row.entityId); return true; } catch { return false; }
    }).map(row => this.safe(row));
    return pageOf(rows, query, { searchable: ['documentNumber', 'fileName'], filterable: ['entityType', 'entityId', 'templateId', 'status', 'outputFormat', 'documentType'],
      sortable: ['createdAt', 'generatedAt', 'documentNumber'], defaultSort: 'createdAt', defaultOrder: 'desc' });
  }

  create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'document.generate');
    body.only(['templateId', 'entityId', 'outputFormat', 'generationKey', 'inputs', 'folderId', 'fileName']);
    const generationKey = body.str('generationKey', { required: true, max: 200 });
    const templateId = body.uuid('templateId', { required: true }), entityId = body.uuid('entityId', { required: true }), folderId = body.uuid('folderId', { required: true });
    const outputFormat = body.enumOf('outputFormat', OUTPUT_FORMATS), fileName = this.fileName(body), raw = body.object('inputs') ?? {};
    const requestHash = fingerprint({ userId: actor.user.id, templateId, entityId, folderId, outputFormat: outputFormat ?? null, fileName, inputs: raw });
    const replay = this.replay(actor, generationKey, requestHash);
    if (replay) return replay;
    const template = this.templates.template(actor, templateId);
    if (!template.isActive) throw new AppError('DOCUMENT_TEMPLATE_INVALID', 'The template is inactive.', 409);
    const format = outputFormat ?? template.outputFormats[0];
    if (!template.outputFormats.includes(format)) throw new AppError('DOCUMENT_TEMPLATE_INVALID', `The template does not produce ${format} output.`, 400, { field: 'outputFormat' });
    return this.enqueue(actor, { revision: this.templates.revision(template), templateId, documentType: template.documentType, title: template.name, entityId,
      folderId, fileName, outputFormat: format, raw, generationKey, requestHash, regeneratedFromId: null });
  }

  regenerate(actor: ActorContext, id: string, body: Body) {
    this.support.require(actor, 'document.generate');
    body.only(['generationKey', 'inputs', 'useCurrentTemplate']);
    const generationKey = body.str('generationKey', { required: true, max: 200 }), useCurrent = body.bool('useCurrentTemplate') ?? true;
    const source = this.document(actor, id), raw = body.object('inputs') ?? source.inputs;
    const requestHash = fingerprint({ userId: actor.user.id, regeneratedFromId: id, useCurrent, inputs: raw });
    const replay = this.replay(actor, generationKey, requestHash);
    if (replay) return replay;
    if (!['READY', 'FAILED'].includes(source.status) || source.supersededById ||
      this.state.generatedDocuments.some(row => row.workspaceId === actor.workspaceId && row.regeneratedFromId === id && ['QUEUED', 'GENERATING'].includes(row.status)))
      throw new AppError('DOCUMENT_STATE_INVALID', 'Only the latest ready or failed document can be regenerated.', 409);
    const template = this.templates.template(actor, source.templateId);
    if (!template.isActive) throw new AppError('DOCUMENT_TEMPLATE_INVALID', 'The template is inactive.', 409);
    const revision = useCurrent ? this.templates.revision(template) : this.templates.revision(source);
    if (revision.templateType === 'DOCX' && source.outputFormat !== 'DOCX') throw new AppError('DOCUMENT_TEMPLATE_INVALID', 'The current template cannot produce the original format.', 409);
    return this.enqueue(actor, { revision, templateId: template.id, documentType: source.documentType, title: template.name, entityId: source.entityId,
      folderId: source.targetFolderId, fileName: source.fileName, outputFormat: source.outputFormat, raw, generationKey, requestHash, regeneratedFromId: source.id });
  }

  remove(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    this.support.require(actor, 'document.delete');
    body.only(['version']);
    const row = this.document(actor, id);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    if (row.status === 'ARCHIVED') return this.safe(row);
    const before = this.summary(row);
    // The File/Version stays as the retained legal artifact; archiving withdraws the document record and stops pending work.
    row.status = 'ARCHIVED'; row.archivedAt = this.support.now(); row.claimId = null; row.leaseExpiresAt = null; row.nextAttemptAt = null;
    this.support.touch(row);
    this.support.audit(actor, row.workspaceId, 'DOCUMENT.ARCHIVED', 'GENERATED_DOCUMENT', row.id, before, this.summary(row));
    this.support.event({ workspaceId: row.workspaceId, type: 'DOCUMENT_ARCHIVED', entityType: 'GENERATED_DOCUMENT', entityId: row.id, actorUserId: actor.user.id,
      changes: { fileId: row.fileId, documentNumber: row.documentNumber } });
    return this.safe(row);
  }

  async download(actor: ActorContext, id: string, query: URLSearchParams) {
    this.support.require(actor, 'document.read');
    const row = this.document(actor, id);
    if (row.status !== 'READY' || !row.fileId) throw new AppError('DOCUMENT_STATE_INVALID', 'Only ready documents can be downloaded.', 409);
    const file = this.state.driveFiles.find(item => item.id === row.fileId && item.workspaceId === row.workspaceId);
    // A later Version on the File is not this generated artifact; it stays available through File Version history.
    if (file && file.currentVersionId !== row.fileVersionId) throw new AppError('DOCUMENT_ARTIFACT_CHANGED', 'The File no longer holds this generated Version.', 409);
    return { documentId: row.id, ...await this.delivery.issue(actor, row.fileId, query) };
  }

  // ---- worker ------------------------------------------------------------------------------------------------------------

  claimDue(limit: number, token: string, now: Date) {
    const due = this.state.generatedDocuments.filter(row => (row.status === 'QUEUED' || row.status === 'GENERATING' && (!row.leaseExpiresAt || row.leaseExpiresAt <= now)) &&
      (!row.nextAttemptAt || row.nextAttemptAt <= now)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit);
    for (const row of due) {
      row.status = 'GENERATING'; row.claimId = token; row.leaseExpiresAt = new Date(now.getTime() + LEASE_MS); row.attempts += 1;
      this.support.touch(row);
    }
    return due.map(row => row.id);
  }
  private live(id: string, token: string, now: Date) {
    return this.state.generatedDocuments.find(row => row.id === id && row.status === 'GENERATING' && row.claimId === token && row.leaseExpiresAt && row.leaseExpiresAt > now);
  }
  prepare(id: string, token: string, now: Date): Ticket | null {
    const row = this.live(id, token, now);
    if (!row) return null;
    try {
      const { revision, context } = this.authorize(row, true);
      const values = revision.variables.map(path => [path, context.resolve(path)] as [string, TemplateValue]);
      return { id, workspaceId: row.workspaceId, token, attempt: row.attempts, revision: structuredClone(revision), values, contextHash: context.hash,
        outputFormat: row.outputFormat, title: this.templateName(row) };
    } catch (error) { this.fail(row, isAppError(error) ? error.code : 'DOCUMENT_GENERATION_FAILED', now); return null; }
  }
  async deliver(ticket: Ticket, signal?: AbortSignal): Promise<DeliveryOutcome> {
    try {
      const values = new Map(ticket.values), context = { resolve: (path: string) => values.get(path) };
      let bytes: Buffer;
      if (ticket.revision.templateType === 'DOCX') bytes = renderDocx(readZip(await this.templates.sourceBytes(ticket.revision)), context);
      else {
        const blocks = htmlToBlocks(renderNodes(parseTemplate(ticket.revision.htmlTemplate!), context, escapeMarkup));
        bytes = ticket.outputFormat === 'PDF' ? blocksToPdf(blocks, ticket.title) : blocksToDocx(blocks);
      }
      const checksum = createHash('sha256').update(bytes).digest('hex');
      // Attempt-scoped keys: a discarded attempt can be garbage-collected without ever aliasing a later published Version.
      const objectKey = `${ticket.workspaceId}/objects/generated-documents/${ticket.id}/${ticket.attempt}-${checksum}`;
      // Scan first: an unavailable processor leaves no object behind; the immutable write is the last fallible step.
      let outcome;
      try { outcome = await this.uploads.contentProcessor().process(bytes, this.mime(ticket.outputFormat), signal); assertProcessingResult(outcome); }
      catch (error) { throw isAppError(error) ? error : new AppError('FILE_PROCESSOR_UNAVAILABLE', 'The scanner and content processor are unavailable.', 503); }
      if (signal?.aborted) throw new AppError('FILE_PROCESSOR_UNAVAILABLE', 'Generation was interrupted.', 503);
      await this.uploads.objectStorage().putImmutable(objectKey, bytes);
      const rendered: Rendered = { objectKey, checksum, size: bytes.length, scanStatus: outcome.scanStatus, processed: outcome.processed };
      return { kind: 'SENT', reference: JSON.stringify(rendered) };
    } catch (error) { return { kind: 'FAILED', code: isAppError(error) ? error.code : 'DOCUMENT_GENERATION_FAILED' }; }
  }
  finish(ticket: Ticket, outcome: DeliveryOutcome, now: Date) {
    const rendered = outcome.kind === 'SENT' ? JSON.parse(outcome.reference ?? 'null') as Rendered : null;
    const row = this.live(ticket.id, ticket.token, now);
    if (!row || row.workspaceId !== ticket.workspaceId || row.attempts !== ticket.attempt) {
      if (rendered) this.discard(ticket.workspaceId, rendered.objectKey, now);
      return false;
    }
    if (!rendered) { this.fail(row, outcome.kind === 'FAILED' ? outcome.code : 'DOCUMENT_GENERATION_FAILED', now); return true; }
    if (rendered.scanStatus === 'BLOCKED') { this.fail(row, 'FILE_BLOCKED', now, rendered.objectKey); return true; }
    if (!rendered.processed) { this.fail(row, 'FILE_PROCESSING_PENDING', now, rendered.objectKey); return true; }
    try {
      const { actor, context } = this.authorize(row, false);
      // The record or its visible fields changed while rendering: never publish stale business data.
      if (context.hash !== ticket.contextHash) throw new AppError('DOCUMENT_CONTEXT_CHANGED', 'The source record changed during generation.', 409);
      this.files.quota(row.workspaceId, rendered.size, rendered.size);
      this.publish(actor, row, rendered, context.hash, now);
    } catch (error) { this.fail(row, isAppError(error) ? error.code : 'DOCUMENT_GENERATION_FAILED', now, rendered.objectKey); }
    return true;
  }

  /** Rebuilds the creator's live authority: membership, permission, template, source record/fields and target folder. */
  private authorize(row: GeneratedDocument, allocateNumber: boolean) {
    const user = this.state.users.find(item => item.id === row.createdByUserId);
    if (!user || !this.support.isEligibleUser(row.workspaceId, user.id)) throw new AppError('DOCUMENT_CREATOR_INACTIVE', 'The requesting user is no longer active.', 403);
    const actor = this.support.access.actor(user, row.workspaceId);
    this.support.require(actor, 'document.generate');
    const template = this.state.documentTemplates.find(item => item.id === row.templateId && item.workspaceId === row.workspaceId);
    if (!template || template.isDeleted || !template.isActive) throw new AppError('DOCUMENT_TEMPLATE_NOT_FOUND', 'Document template was not found.', 404);
    const revision = this.templates.revision(row);
    this.storages.folderAuthority(actor, row.targetFolderId, 'file.create', 2);
    if (allocateNumber && !row.documentNumber && template.numberPrefix) { row.documentNumber = this.allocateNumber(row, template.numberPrefix); this.support.touch(row); }
    const inputs = this.templates.inputs(revision.schemaJson, row.inputs as Record<string, unknown>, true);
    const context = this.templates.context(actor, revision, row.entityId, inputs, { number: row.documentNumber, date: row.createdAt, title: template.name, type: row.documentType });
    return { actor, revision, context };
  }
  /** Regenerations keep the business number of the document they replace; new documents take the next number. */
  private allocateNumber(row: GeneratedDocument, prefix: string) {
    const origin = row.regeneratedFromId ? this.state.generatedDocuments.find(item => item.id === row.regeneratedFromId && item.workspaceId === row.workspaceId) : undefined;
    if (origin?.documentNumber) return origin.documentNumber;
    const used = this.state.generatedDocuments.filter(item => item.workspaceId === row.workspaceId && item.documentType === row.documentType && item.documentNumber?.startsWith(prefix))
      .map(item => Number(item.documentNumber!.slice(prefix.length))).filter(Number.isSafeInteger);
    return `${prefix}${String(Math.max(0, ...used) + 1).padStart(6, '0')}`;
  }
  private publish(actor: ActorContext, row: GeneratedDocument, rendered: Rendered, contextHash: string, now: Date) {
    const folder = this.storages.folderAuthority(actor, row.targetFolderId, 'file.create', 2);
    const extension = row.outputFormat === 'PDF' ? 'pdf' : 'docx', mimeType = this.mime(row.outputFormat);
    const base = (row.fileName ?? `${this.templateName(row)}${row.documentNumber ? ` ${row.documentNumber}` : ''}`).slice(0, 400);
    const taken = (name: string) => this.state.driveFiles.some(file => file.workspaceId === row.workspaceId && file.storageId === folder.storageId && file.folderId === folder.id &&
      file.status !== 'TRASHED' && file.name.trim().normalize('NFC').toLowerCase() === name.trim().normalize('NFC').toLowerCase());
    const name = taken(`${base}.${extension}`) ? `${base} (${row.id}).${extension}` : `${base}.${extension}`;
    const file: DriveFile = { id: this.support.id(), workspaceId: row.workspaceId, storageId: folder.storageId, folderId: folder.id, name, extension, mimeType,
      currentVersionId: null, status: 'ACTIVE', sizeBytesCurrent: rendered.size, version: 1, publicShareVersion: 1, originalFolderId: null, statusBeforeTrash: null,
      trashedAt: null, purgeAfter: null, createdAt: now, updatedAt: now };
    const version: DriveFileVersion = { id: this.support.id(), workspaceId: row.workspaceId, fileId: file.id, versionNumber: 1, objectKey: rendered.objectKey,
      sizeBytes: rendered.size, checksum: rendered.checksum, mimeType, createdByUserId: row.createdByUserId, createdAt: now, processedAt: now, scanStatus: 'CLEAN' };
    file.currentVersionId = version.id;
    this.state.driveFiles.push(file); this.state.driveFileVersions.push(version);
    this.support.audit(actor, row.workspaceId, 'FILE.CREATED', 'FILE', file.id, null, { name, folderId: folder.id, generatedDocumentId: row.id });
    this.support.event({ workspaceId: row.workspaceId, type: 'FILE_CREATED', entityType: 'FILE', entityId: file.id, actorUserId: actor.user.id, changes: { folderId: folder.id, generatedDocumentId: row.id } });
    this.support.event({ workspaceId: row.workspaceId, type: 'FILE_VERSION_CREATED', entityType: 'FILE', entityId: file.id, actorUserId: actor.user.id, changes: { versionId: version.id } });
    const attachment = { id: this.support.id(), workspaceId: row.workspaceId, fileId: file.id, entityType: row.entityType, entityId: row.entityId, role: 'DOCUMENT' as const,
      attachedByUserId: row.createdByUserId, createdAt: now };
    this.state.fileAttachments.push(attachment);
    this.support.event({ workspaceId: row.workspaceId, type: 'FILE_ATTACHED', entityType: 'FILE_ATTACHMENT', entityId: attachment.id, actorUserId: actor.user.id,
      changes: { fileId: file.id, entityType: row.entityType, entityId: row.entityId, role: 'DOCUMENT' } });
    row.status = 'READY'; row.fileId = file.id; row.fileVersionId = version.id; row.contextHash = contextHash; row.generatedAt = now; row.errorCode = null;
    row.claimId = null; row.leaseExpiresAt = null; row.nextAttemptAt = null;
    this.support.touch(row);
    const previous = row.regeneratedFromId ? this.state.generatedDocuments.find(item => item.id === row.regeneratedFromId && item.workspaceId === row.workspaceId) : undefined;
    if (previous && previous.status === 'READY' && !previous.supersededById) { previous.supersededById = row.id; this.support.touch(previous); }
    this.support.audit(actor, row.workspaceId, 'DOCUMENT.GENERATED', 'GENERATED_DOCUMENT', row.id, null, this.summary(row));
    this.support.event({ workspaceId: row.workspaceId, type: 'DOCUMENT_GENERATED', entityType: 'GENERATED_DOCUMENT', entityId: row.id, actorUserId: actor.user.id,
      changes: { fileId: file.id, versionId: version.id, documentNumber: row.documentNumber, regeneratedFromId: row.regeneratedFromId }, audienceUserIds: [row.createdByUserId] });
  }
  private fail(row: GeneratedDocument, code: string, now: Date, objectKey?: string) {
    if (objectKey) this.discard(row.workspaceId, objectKey, now);
    row.claimId = null; row.leaseExpiresAt = null; row.errorCode = code;
    if (TERMINAL.has(code) || row.attempts >= MAX_ATTEMPTS) {
      row.status = 'FAILED'; row.nextAttemptAt = null;
      this.support.audit(null, row.workspaceId, 'DOCUMENT.GENERATION_FAILED', 'GENERATED_DOCUMENT', row.id, null, { errorCode: code, attempts: row.attempts });
      this.support.event({ workspaceId: row.workspaceId, type: 'DOCUMENT_GENERATION_FAILED', entityType: 'GENERATED_DOCUMENT', entityId: row.id, actorUserId: null,
        changes: { errorCode: code, attempts: row.attempts }, audienceUserIds: [row.createdByUserId] });
    } else {
      row.status = 'QUEUED';
      row.nextAttemptAt = new Date(now.getTime() + Math.min(3600_000, 2000 * 2 ** Math.min(row.attempts, 10)));
    }
    this.support.touch(row);
  }
  /** Unpublished output is queued for the existing object garbage worker. */
  private discard(workspaceId: string, objectKey: string, now: Date) {
    if (this.state.driveFileVersions.some(row => row.objectKey === objectKey) || this.state.fileObjectGarbage.some(row => row.workspaceId === workspaceId && row.objectKey === objectKey)) return;
    this.state.fileObjectGarbage.push({ id: this.support.id(), workspaceId, objectKey, createdAt: now, updatedAt: now, claimId: null, leaseExpiresAt: null,
      nextAttemptAt: now, attempts: 0, errorCode: null, cleanedAt: null });
  }

  private replay(actor: ActorContext, generationKey: string, requestHash: string) {
    const existing = this.state.generatedDocuments.find(row => row.workspaceId === actor.workspaceId && row.generationKey === generationKey);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw new AppError('DOCUMENT_GENERATION_DUPLICATE', 'This generationKey was already used for another request.', 409);
    this.authorizeSource(actor, existing.entityType, existing.entityId);
    return this.safe(existing);
  }
  private enqueue(actor: ActorContext, input: { revision: DocumentTemplateRevision; templateId: string; documentType: string; title: string; entityId: string; folderId: string;
    fileName: string | null; outputFormat: GeneratedDocument['outputFormat']; raw: Record<string, unknown>; generationKey: string; requestHash: string; regeneratedFromId: string | null }) {
    const inputs = this.templates.inputs(input.revision.schemaJson, input.raw, true);
    // Fail fast on source/field authority; the worker proves it again before publishing.
    this.templates.context(actor, input.revision, input.entityId, inputs, { number: null, date: this.support.now(), title: input.title, type: input.documentType });
    this.storages.folderAuthority(actor, input.folderId, 'file.create', 2);
    const now = this.support.now();
    const row: GeneratedDocument = { id: this.support.id(), workspaceId: actor.workspaceId, documentType: input.documentType, entityType: input.revision.entityType,
      entityId: input.entityId, templateId: input.templateId, templateRevisionId: input.revision.id, outputFormat: input.outputFormat, targetFolderId: input.folderId,
      fileName: input.fileName, fileId: null, fileVersionId: null, documentNumber: null, status: 'QUEUED', generationKey: input.generationKey, requestHash: input.requestHash,
      inputs, contextHash: null, errorCode: null, regeneratedFromId: input.regeneratedFromId, supersededById: null, attempts: 0, claimId: null, leaseExpiresAt: null,
      nextAttemptAt: now, generatedAt: null, archivedAt: null, createdByUserId: actor.user.id, version: 1, createdAt: now, updatedAt: now };
    this.state.generatedDocuments.push(row);
    this.support.event({ workspaceId: row.workspaceId, type: 'DOCUMENT_GENERATION_QUEUED', entityType: 'GENERATED_DOCUMENT', entityId: row.id, actorUserId: actor.user.id,
      changes: { templateId: row.templateId, templateRevisionId: row.templateRevisionId, entityType: row.entityType, entityId: row.entityId, regeneratedFromId: row.regeneratedFromId },
      audienceUserIds: [actor.user.id] });
    return this.safe(row);
  }
  private fileName(body: Body) {
    const name = body.str('fileName', { max: 200 })?.normalize('NFC') ?? null;
    if (name !== null && (!name || /[\\/\u0000-\u001f\u007f]/.test(name) || /^\.+$/.test(name)))
      throw new AppError('VALIDATION_ERROR', 'fileName may not contain path separators or control characters.', 400, { field: 'fileName' });
    return name;
  }
  private templateName(row: GeneratedDocument) {
    return this.state.documentTemplates.find(item => item.id === row.templateId && item.workspaceId === row.workspaceId)?.name ?? row.documentType;
  }
  private mime(format: GeneratedDocument['outputFormat']) { return format === 'PDF' ? PDF_MIME : DOCX_MIME; }
  private summary(row: GeneratedDocument) {
    return { status: row.status, documentType: row.documentType, entityType: row.entityType, entityId: row.entityId, templateRevisionId: row.templateRevisionId,
      outputFormat: row.outputFormat, documentNumber: row.documentNumber, fileId: row.fileId, fileVersionId: row.fileVersionId, regeneratedFromId: row.regeneratedFromId };
  }
}
