import { createHash } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError } from '../../errors';
import { Body, type CollabSupport, fingerprint, isCalendarDate, pageOf, validationError } from '../support';
import { assertInertHtml, docxText, escapeMarkup, inspectDocx, invalidTemplate, parseTemplate, readZip, renderDocxEntries, renderNodes, variablesOf, type RenderContext, type TemplateValue } from './document-render';
import { INPUT_TYPES, OUTPUT_FORMATS, TEMPLATE_TYPES, type DocumentContextAdapter, type DocumentTemplate, type DocumentTemplateRevision, type TemplateInput, type TemplateSchema } from './document-types';
import type { ProjectDriveService } from './project-drive-service';
import type { UploadService } from './upload-service';

const MAX_HTML = 256 * 1024, MAX_DOCX = 10 * 1024 * 1024, KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DOCUMENT_FIELDS = ['number', 'date', 'title', 'type'], WORKSPACE_FIELDS = ['name'];
const MUTABLE = ['name', 'description', 'documentType', 'outputFormats', 'numberPrefix', 'htmlTemplate', 'sourceFileId', 'schemaJson', 'isActive'];

export type DocumentMeta = { number: string | null; date: Date; title: string; type: string };
type Content = { htmlTemplate: string | null; sourceFileId: string | null; schemaJson: TemplateSchema };

/** Template definitions, immutable content revisions and the registry of permission-checked source adapters. */
export class DocumentTemplateService {
  private readonly adapters = new Map<string, DocumentContextAdapter>();
  constructor(private readonly support: CollabSupport, private readonly storages: ProjectDriveService, private readonly uploads: UploadService,
    private readonly bindings: (actor: ActorContext, fileId: string) => void) {}
  private get state() { return this.support.state; }
  registerContext(adapter: DocumentContextAdapter) { this.adapters.set(adapter.entityType, adapter); }
  adapter(entityType: string) {
    const adapter = this.adapters.get(entityType);
    if (!adapter) throw invalidTemplate(`${entityType} cannot be a document source.`, { field: 'entityType' });
    return adapter;
  }

  safe(row: DocumentTemplate) {
    const { isDeleted, deletedAt, ...rest } = row;
    return { ...rest, schemaJson: structuredClone(row.schemaJson), outputFormats: [...row.outputFormats] };
  }
  template(actor: ActorContext, id: string, includeDeleted = false) {
    const row = this.state.documentTemplates.find(item => item.id === id && item.workspaceId === actor.workspaceId && (includeDeleted || !item.isDeleted));
    if (!row) throw new AppError('DOCUMENT_TEMPLATE_NOT_FOUND', 'Document template was not found.', 404);
    return row;
  }
  revision(row: { workspaceId: string; templateRevisionId?: string; currentRevisionId?: string }) {
    const id = row.templateRevisionId ?? row.currentRevisionId;
    const revision = this.state.documentTemplateRevisions.find(item => item.id === id && item.workspaceId === row.workspaceId);
    if (!revision) throw new AppError('DOCUMENT_TEMPLATE_NOT_FOUND', 'Document template revision was not found.', 404);
    return revision;
  }

  get(actor: ActorContext, id: string) {
    this.support.require(actor, 'document_template.read');
    return this.safe(this.template(actor, id));
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'document_template.read');
    const rows = this.state.documentTemplates.filter(row => row.workspaceId === actor.workspaceId && !row.isDeleted).map(row => this.safe(row));
    return pageOf(rows, query, { searchable: ['name', 'description'], filterable: ['templateType', 'entityType', 'documentType', 'isActive'],
      sortable: ['name', 'createdAt', 'updatedAt'], defaultSort: 'name' });
  }

  async create(actor: ActorContext, body: Body) {
    this.support.require(actor, 'document_template.create');
    body.only(['templateType', 'entityType', ...MUTABLE]);
    const templateType = body.enumOf('templateType', TEMPLATE_TYPES, { required: true });
    const entityType = body.str('entityType', { required: true, max: 50 });
    this.adapter(entityType);
    const now = this.support.now(), id = this.support.id();
    const meta = this.metadata(body, templateType, null);
    this.validateFormats(templateType, meta.outputFormats);
    const row: DocumentTemplate = { id, workspaceId: actor.workspaceId, templateType, entityType, ...meta,
      sourceFileId: null, htmlTemplate: null, schemaJson: { inputs: {} }, currentRevisionId: '', currentRevision: 0, isDeleted: false, deletedAt: null,
      createdByUserId: actor.user.id, updatedByUserId: actor.user.id, version: 1, createdAt: now, updatedAt: now };
    await this.applyContent(actor, row, this.content(body, row, true));
    this.state.documentTemplates.push(row);
    this.record(actor, row, 'CREATED', null);
    return this.safe(row);
  }
  replace(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only([...MUTABLE, 'version']);
    return this.update(actor, id, body, ifMatch, true);
  }
  patch(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    body.only([...MUTABLE, 'version']);
    return this.update(actor, id, body, ifMatch, false);
  }
  private async update(actor: ActorContext, id: string, body: Body, ifMatch: number | undefined, full: boolean) {
    this.support.require(actor, 'document_template.update');
    const row = this.template(actor, id);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const before = this.summary(row);
    const meta = this.metadata(body, row.templateType, full ? null : row), content = this.content(body, row, full);
    this.validateFormats(row.templateType, meta.outputFormats);
    const changed = fingerprint({ html: content.htmlTemplate, source: content.sourceFileId, schema: content.schemaJson }) !==
      fingerprint({ html: row.htmlTemplate, source: row.sourceFileId, schema: row.schemaJson });
    // Re-selecting the same source File still snapshots its current Version: the File may have changed underneath.
    if (changed || full && row.templateType === 'DOCX' || body.has('sourceFileId')) await this.applyContent(actor, row, content);
    Object.assign(row, meta);
    row.updatedByUserId = actor.user.id;
    this.support.touch(row);
    this.record(actor, row, 'UPDATED', before);
    return this.safe(row);
  }
  delete(actor: ActorContext, id: string, body: Body, ifMatch?: number) {
    this.support.require(actor, 'document_template.delete');
    body.only(['version']);
    const row = this.template(actor, id);
    this.support.expectVersion(row, body.raw.version ?? ifMatch);
    const before = this.summary(row);
    // Revisions and generated history remain; the definition simply stops accepting new generations.
    row.isDeleted = true; row.isActive = false; row.deletedAt = this.support.now(); row.updatedByUserId = actor.user.id;
    this.support.touch(row);
    this.record(actor, row, 'DELETED', before);
    return { id: row.id, deleted: true };
  }

  async preview(actor: ActorContext, id: string, body: Body) {
    this.support.require(actor, 'document_template.read');
    body.only(['entityId', 'inputs']);
    const row = this.template(actor, id), revision = this.revision(row);
    const entityId = body.uuid('entityId');
    const inputs = this.inputs(revision.schemaJson, body.object('inputs') ?? {}, false);
    const context = this.context(actor, revision, entityId ?? null, inputs, { number: null, date: this.support.now(), title: row.name, type: row.documentType }, !entityId);
    if (revision.templateType === 'HTML')
      return { templateId: row.id, revision: revision.revision, format: 'HTML', content: renderNodes(parseTemplate(revision.htmlTemplate!), context, escapeMarkup), variables: revision.variables };
    const entries = renderDocxEntries(readZip(await this.sourceBytes(revision)), context);
    return { templateId: row.id, revision: revision.revision, format: 'TEXT', content: docxText(entries), variables: revision.variables };
  }

  /** Immutable template bytes owned by the revision; later File edits or purges cannot change published templates. */
  async sourceBytes(revision: DocumentTemplateRevision) {
    let bytes: Buffer;
    try { bytes = await this.uploads.objectStorage().read(revision.sourceObjectKey!); }
    catch { throw new AppError('DOCUMENT_GENERATION_FAILED', 'Template content is temporarily unavailable.', 503); }
    if (bytes.length !== revision.sourceSizeBytes || createHash('sha256').update(bytes).digest('hex') !== revision.sourceChecksum)
      throw new AppError('DOCUMENT_GENERATION_FAILED', 'Template content failed integrity verification.', 503);
    return bytes;
  }

  /** Validates caller inputs against the revision schema. Unknown keys are refused; values are never interpreted as markup. */
  inputs(schema: TemplateSchema, raw: Record<string, unknown>, strict: boolean) {
    const values: Record<string, TemplateValue> = {};
    for (const key of Object.keys(raw)) if (!schema.inputs[key]) throw validationError(`inputs.${key}`, `inputs.${key} is not declared by the template.`);
    for (const [key, definition] of Object.entries(schema.inputs)) {
      const value = raw[key], field = `inputs.${key}`;
      if (value === undefined || value === null) {
        if (strict && definition.required) throw validationError(field, `${field} is required.`);
        continue;
      }
      if (definition.type === 'string') {
        if (typeof value !== 'string') throw validationError(field, `${field} must be a string.`);
        if (value.length > (definition.maxLength ?? 1000)) throw validationError(field, `${field} is too long.`);
        if (definition.enum && !definition.enum.includes(value)) throw validationError(field, `${field} must be one of ${definition.enum.join(', ')}.`);
      } else if (definition.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw validationError(field, `${field} must be a finite number.`);
      } else if (definition.type === 'boolean') {
        if (typeof value !== 'boolean') throw validationError(field, `${field} must be a boolean.`);
      } else if (typeof value !== 'string' || !isCalendarDate(value)) throw validationError(field, `${field} must be a calendar date (YYYY-MM-DD).`);
      values[key] = value as TemplateValue;
    }
    return values;
  }

  /**
   * Builds the render context through the owning module's adapter. Only variables the revision references are read;
   * a referenced entity field the actor cannot see fails the whole operation instead of rendering partial data.
   */
  context(actor: ActorContext, revision: DocumentTemplateRevision, entityId: string | null, inputs: Record<string, TemplateValue>, meta: DocumentMeta, sample = false) {
    let record: ReturnType<DocumentContextAdapter['read']> | null = null;
    if (entityId) {
      const adapter = this.adapter(revision.entityType);
      try { record = adapter.read(actor, entityId); }
      catch { throw new AppError('DOCUMENT_CONTEXT_ACCESS_DENIED', 'The source record is inaccessible.', 403); }
    }
    const workspace = this.state.workspaces.find(row => row.id === revision.workspaceId)?.name ?? '';
    const values = new Map<string, TemplateValue>();
    for (const path of revision.variables) {
      const [root, key, sub] = path.split('.');
      if (root === 'entity') {
        if (!record) { values.set(path, sample ? `[${path}]` : ''); continue; }
        const source = key === 'customFields' ? record.customFields ?? {} : record.fields, name = key === 'customFields' ? sub : key;
        if (!Object.prototype.hasOwnProperty.call(source, name)) throw new AppError('DOCUMENT_CONTEXT_ACCESS_DENIED', 'A referenced source field is not readable.', 403, { variable: path });
        values.set(path, source[name]);
      } else if (root === 'input') values.set(path, inputs[key] ?? (sample ? `[${path}]` : null));
      else if (root === 'document') values.set(path, key === 'number' ? meta.number : key === 'date' ? new Date(meta.date.toISOString().slice(0, 10)) : key === 'title' ? meta.title : meta.type);
      else values.set(path, workspace);
    }
    const context: RenderContext & { hash: string } = { resolve: path => values.get(path), hash: fingerprint([...values.entries()].sort(([a], [b]) => a.localeCompare(b))) };
    return context;
  }

  private metadata(body: Body, templateType: DocumentTemplate['templateType'], current: DocumentTemplate | null) {
    const pick = <T>(key: string, read: () => T, fallback: T) => body.has(key) ? read() : current ? (current as unknown as Record<string, T>)[key] : fallback;
    const name = pick('name', () => body.str('name', { required: true, max: 200 }).normalize('NFC'), undefined as unknown as string);
    if (!name) throw validationError('name', 'name is required.');
    const documentType = pick('documentType', () => body.str('documentType', { required: true, max: 50 }), undefined as unknown as string);
    if (!documentType || !/^[A-Z][A-Z0-9_]{0,49}$/.test(documentType)) throw validationError('documentType', 'documentType must be an upper-case identifier.');
    const numberPrefix = pick('numberPrefix', () => body.str('numberPrefix', { max: 20 }) ?? null, null);
    if (numberPrefix !== null && !/^[A-Za-z0-9_./-]{1,20}$/.test(numberPrefix)) throw validationError('numberPrefix', 'numberPrefix may contain letters, digits and _ . / - only.');
    const formats = pick<DocumentTemplate['outputFormats']>('outputFormats', () => {
      const raw = body.array('outputFormats', { max: 2 }) ?? [];
      if (!raw.length || raw.some(value => !OUTPUT_FORMATS.includes(value as never))) throw validationError('outputFormats', `outputFormats must contain ${OUTPUT_FORMATS.join(', ')}.`);
      return [...new Set(raw as Array<typeof OUTPUT_FORMATS[number]>)];
    }, templateType === 'HTML' ? ['PDF'] : ['DOCX']);
    return { name, documentType, numberPrefix, outputFormats: formats,
      description: pick('description', () => body.str('description', { max: 2000 }) ?? null, null),
      isActive: pick('isActive', () => body.bool('isActive') ?? true, true) };
  }
  private validateFormats(templateType: DocumentTemplate['templateType'], formats: DocumentTemplate['outputFormats']) {
    if (templateType === 'DOCX' && formats.some(format => format !== 'DOCX')) throw invalidTemplate('DOCX templates produce DOCX output only.', { field: 'outputFormats' });
  }
  private content(body: Body, row: DocumentTemplate, full: boolean): Content {
    const html = row.templateType === 'HTML', field = html ? 'htmlTemplate' : 'sourceFileId', other = html ? 'sourceFileId' : 'htmlTemplate';
    if (body.has(other)) throw validationError(other, `${other} is not used by ${row.templateType} templates.`);
    const value = body.has(field) || full ? (html ? body.str('htmlTemplate', { required: true, trim: false, max: MAX_HTML }) : body.uuid('sourceFileId', { required: true })) : html ? row.htmlTemplate : row.sourceFileId;
    return { htmlTemplate: html ? value : null, sourceFileId: html ? null : value, schemaJson: body.has('schemaJson') || full ? this.schema(body.object('schemaJson') ?? { inputs: {} }) : row.schemaJson };
  }
  private schema(raw: Record<string, unknown>): TemplateSchema {
    new Body(raw).only(['inputs']);
    const inputs = raw.inputs ?? {};
    if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) throw validationError('schemaJson.inputs', 'schemaJson.inputs must be an object.');
    const entries = Object.entries(inputs as Record<string, unknown>);
    if (entries.length > 100) throw validationError('schemaJson.inputs', 'At most 100 inputs may be declared.');
    const result: TemplateSchema = { inputs: {} };
    for (const [key, value] of entries) {
      const field = `schemaJson.inputs.${key}`;
      if (!KEY_RE.test(key)) throw validationError(field, 'Input keys must be identifiers.');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError(field, `${field} must be an object.`);
      const definition = new Body(value as Record<string, unknown>).only(['type', 'required', 'label', 'maxLength', 'enum']);
      const type = definition.enumOf('type', INPUT_TYPES, { required: true });
      const input: TemplateInput = { type, required: definition.bool('required') ?? false };
      const label = definition.str('label', { max: 200 }); if (label) input.label = label;
      const maxLength = definition.int('maxLength', { min: 1, max: 10000 });
      const choices = definition.array('enum', { max: 100 });
      if ((maxLength != null || choices) && type !== 'string') throw validationError(field, 'maxLength and enum apply to string inputs only.');
      if (maxLength != null) input.maxLength = maxLength;
      if (choices) {
        if (!choices.length || choices.some(choice => typeof choice !== 'string' || choice.length > 200)) throw validationError(`${field}.enum`, 'enum must list strings of at most 200 characters.');
        input.enum = [...new Set(choices as string[])];
      }
      result.inputs[key] = input;
    }
    return result;
  }
  private validateVariables(entityType: string, schema: TemplateSchema, variables: Set<string>) {
    const adapter = this.adapter(entityType);
    for (const path of variables) {
      const [root, key, sub, extra] = path.split('.');
      const ok = root === 'entity' ? (key === 'customFields' ? Boolean(adapter.supportsCustomFields && sub && KEY_RE.test(sub) && !extra) : adapter.fields.includes(key) && !sub)
        : root === 'input' ? Boolean(schema.inputs[key]) && !sub
        : root === 'document' ? DOCUMENT_FIELDS.includes(key) && !sub
        : root === 'workspace' && WORKSPACE_FIELDS.includes(key) && !sub;
      if (!ok) throw invalidTemplate(`Unknown template variable "${path}".`, { variable: path });
    }
  }
  /** Validates content and records a new immutable revision when it differs from the current one. */
  private async applyContent(actor: ActorContext, row: DocumentTemplate, content: Content) {
    let variables: Set<string>, source: { fileId: string; versionId: string; bytes: Buffer; checksum: string } | null = null;
    if (row.templateType === 'HTML') {
      assertInertHtml(content.htmlTemplate!);
      variables = variablesOf(parseTemplate(content.htmlTemplate!));
    } else {
      let file;
      try { file = this.storages.fileAuthority(actor, content.sourceFileId!, 'file.read', 1); this.bindings(actor, file.id); }
      catch { throw new AppError('DOCUMENT_TEMPLATE_INVALID', 'The source File is inaccessible.', 400, { field: 'sourceFileId' }); }
      const version = this.state.driveFileVersions.find(item => item.workspaceId === actor.workspaceId && item.fileId === file.id && item.id === file.currentVersionId);
      if (file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt) throw invalidTemplate('The source File must have clean, processed content.', { field: 'sourceFileId' });
      if (version.sizeBytes > MAX_DOCX) throw invalidTemplate('DOCX templates may be at most 10 MiB.', { field: 'sourceFileId' });
      let bytes: Buffer;
      try { bytes = await this.uploads.objectStorage().read(version.objectKey); }
      catch { throw new AppError('FILE_CONTENT_UNAVAILABLE', 'File content is temporarily unavailable.', 503); }
      if (bytes.length !== version.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== version.checksum)
        throw new AppError('FILE_CONTENT_UNAVAILABLE', 'File content failed integrity verification.', 503);
      variables = inspectDocx(bytes).variables;
      source = { fileId: file.id, versionId: version.id, bytes, checksum: version.checksum };
    }
    this.validateVariables(row.entityType, content.schemaJson, variables);
    const contentHash = fingerprint({ html: content.htmlTemplate, source: source?.checksum ?? null, schema: content.schemaJson });
    const current = row.currentRevisionId ? this.revision(row) : null;
    if (current?.contentHash === contentHash) { Object.assign(row, content); return; }
    const id = this.support.id(), objectKey = source ? `${row.workspaceId}/objects/document-templates/${row.id}/${id}-${source.checksum}` : null;
    if (source) await this.uploads.objectStorage().putImmutable(objectKey!, source.bytes);
    Object.assign(row, content);
    const revision: DocumentTemplateRevision = { id, workspaceId: row.workspaceId, templateId: row.id, revision: row.currentRevision + 1, templateType: row.templateType,
      entityType: row.entityType, htmlTemplate: content.htmlTemplate, sourceFileId: source?.fileId ?? null, sourceVersionId: source?.versionId ?? null,
      sourceObjectKey: objectKey, sourceChecksum: source?.checksum ?? null, sourceSizeBytes: source?.bytes.length ?? null, schemaJson: structuredClone(content.schemaJson),
      variables: [...variables].sort(), contentHash, createdByUserId: actor.user.id, createdAt: this.support.now() };
    this.state.documentTemplateRevisions.push(revision);
    row.currentRevisionId = revision.id; row.currentRevision = revision.revision;
  }
  private summary(row: DocumentTemplate) {
    return { name: row.name, documentType: row.documentType, entityType: row.entityType, templateType: row.templateType, outputFormats: [...row.outputFormats],
      numberPrefix: row.numberPrefix, isActive: row.isActive, isDeleted: row.isDeleted, revision: row.currentRevision, revisionId: row.currentRevisionId,
      contentHash: row.currentRevisionId ? this.revision(row).contentHash : null };
  }
  private record(actor: ActorContext, row: DocumentTemplate, action: 'CREATED' | 'UPDATED' | 'DELETED', before: unknown) {
    this.support.audit(actor, row.workspaceId, `DOCUMENT_TEMPLATE.${action}`, 'DOCUMENT_TEMPLATE', row.id, before, action === 'DELETED' ? null : this.summary(row));
    this.support.event({ workspaceId: row.workspaceId, type: 'DOCUMENT_TEMPLATE_CHANGED', entityType: 'DOCUMENT_TEMPLATE', entityId: row.id, actorUserId: actor.user.id,
      changes: { action, revision: row.currentRevision, isActive: row.isActive } });
  }
}
