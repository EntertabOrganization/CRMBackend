import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { User } from '../domain';
import { AppError, badRequest, conflict, unauthorized } from '../errors';
import { checkRateLimit } from '../rate-limit';
import { PERMISSION_CATALOG } from '../permissions';
import type { ActionContext, ActionDescriptor, ActionServices, NetworkCall } from './actions';
import { ActionError, buildWebhookCall } from './actions';
import type { AutomationEngine } from './engine';
import { assertSafeUrlShape } from './egress';
import type { AutomationRegistry, ConfigField, Problem } from './registry';
import { redact } from './redact';
import type { RuleService } from './rule-service';
import { validateAgainstSchema, validateSchemaDefinition } from './schema';
import type { AutomationSupport, Json } from './support';
import { isPlainObject, sha256 } from './support';
import type { AutomationCredential, AutomationExtension, ExtensionHandler, ExtensionKind, SchemaNode, TriggerContext } from './types';
import { AUTOMATION_PERMISSIONS as P } from './types';

const CODE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
const SECRET_REF = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_PAYLOAD_BYTES = 10_000;

export type ExtensionRuntimeInput = {
  workspaceId: string;
  extensionCode: string;
  target: { type: string; id: string; title: string };
  config: Record<string, unknown>;
  idempotencyKey: string;
  identityUserId: string;
};
export type ExtensionRuntimeHandler = (input: ExtensionRuntimeInput) => Promise<Record<string, unknown>> | Record<string, unknown>;

function fieldsFromSchema(schema: SchemaNode | null): ConfigField[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([key, node]) => ({
    key,
    label: node.description ?? key,
    type: node.format === 'secret-ref' ? 'secret-ref' : node.format === 'uri' ? 'url' : node.type === 'boolean' ? 'boolean' : node.type === 'number' || node.type === 'integer' ? 'number' : node.enum ? 'select' : 'text',
    required: schema.required?.includes(key),
    options: node.enum?.map((value) => ({ value: String(value), label: String(value) })),
  }));
}

/** A registered custom Action: typed configuration, controlled handler, never tenant code. */
class ExtensionAction implements ActionDescriptor {
  readonly category = 'Integrations';
  readonly idempotency = 'PROVIDER_KEY' as const;
  readonly supportsContinueOnError = true;
  readonly isExtension = true;

  constructor(
    private readonly extension: AutomationExtension,
    private readonly handlers: Map<string, ExtensionRuntimeHandler>,
  ) {}

  get code() {
    return `ext.${this.extension.code}`;
  }
  get label() {
    return this.extension.name;
  }
  get description() {
    return this.extension.description ?? '';
  }
  get ownerModule() {
    return `Integration: ${this.extension.installationId}`;
  }
  get targetTypes() {
    return this.extension.targetTypes;
  }
  get configFields() {
    return fieldsFromSchema(this.extension.configSchema);
  }
  get sideEffect(): 'ADAPTER' | 'NETWORK' {
    return this.extension.handler?.kind === 'HTTP' ? 'NETWORK' : 'ADAPTER';
  }
  get timeoutMs() {
    return this.extension.handler?.kind === 'HTTP' ? Math.min(this.extension.handler.timeoutMs ?? 10_000, 15_000) : 15_000;
  }
  get allPermissions() {
    return this.extension.permissions;
  }
  requiredPermissions() {
    return this.extension.permissions;
  }
  isAvailable() {
    if (!this.extension.enabled || !this.extension.handler) return false;
    return this.extension.handler.kind === 'HTTP' || this.handlers.has(this.extension.handler.handlerCode);
  }
  validate(config: Record<string, unknown>): Problem[] {
    if (!this.extension.configSchema) return Object.keys(config).map((key) => ({ path: `$.${key}`, code: 'AUTOMATION_ACTION_CONFIG_INVALID', message: `Unsupported setting "${key}".` }));
    return validateAgainstSchema(this.extension.configSchema, config).map((problem) => ({ path: problem.path, code: 'AUTOMATION_ACTION_CONFIG_INVALID', message: problem.message }));
  }
  preview(resolved: Record<string, unknown>) {
    return { extension: this.extension.code, config: redact(resolved) };
  }
  private payload(ctx: ActionContext, input: Record<string, unknown>) {
    return { extension: this.extension.code, schemaVersion: this.extension.schemaVersion, idempotencyKey: ctx.idempotencyKey, target: { type: ctx.targetType, id: ctx.target.id, title: ctx.target.title }, config: input };
  }
  buildNetworkCall(ctx: ActionContext, input: Record<string, unknown>): NetworkCall {
    const handler = this.extension.handler;
    if (handler?.kind !== 'HTTP') throw new ActionError('AUTOMATION_EXTENSION_DISABLED', 'The extension has no HTTP handler.');
    return buildWebhookCall(ctx, { body: this.payload(ctx, input) }, { url: handler.url, method: handler.method ?? 'POST', secretRef: handler.secretRef ?? null, timeoutMs: handler.timeoutMs });
  }
  summarizeNetwork(response: { status: number; bytes: number }) {
    return { status: response.status, responseBytes: response.bytes };
  }
  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const handler = this.extension.handler;
    if (handler?.kind !== 'REGISTERED') throw new ActionError('AUTOMATION_EXTENSION_DISABLED', 'The extension has no registered handler.');
    const run = this.handlers.get(handler.handlerCode);
    if (!run) throw new ActionError('AUTOMATION_EXTENSION_DISABLED', 'The extension handler is not installed.');
    // The handler only ever sees scoped, validated inputs - never the store, the identity token or other tenants' data.
    const result = await run({ workspaceId: ctx.workspaceId, extensionCode: this.extension.code, target: { type: ctx.targetType, id: ctx.target.id, title: ctx.target.title }, config: input, idempotencyKey: ctx.idempotencyKey, identityUserId: ctx.user.id });
    return redact(isPlainObject(result) ? result : {});
  }
}

/** Custom Trigger/Action registration, integration credentials and authenticated custom-trigger ingestion. */
export class ExtensionService {
  private readonly handlers = new Map<string, ExtensionRuntimeHandler>();

  constructor(
    private readonly support: AutomationSupport,
    private readonly registry: AutomationRegistry,
    private readonly rules: RuleService,
    private readonly engine: AutomationEngine,
    private readonly services: ActionServices,
  ) {
    registry.extensionActionResolver = (workspaceId, code, includeDisabled) => {
      if (!code.startsWith('ext.')) return undefined;
      const extension = registry.extensionsOf(workspaceId, 'ACTION').find((item) => `ext.${item.code}` === code && (includeDisabled || item.enabled));
      return extension ? new ExtensionAction(extension, this.handlers) : undefined;
    };
    registry.extensionActionList = (workspaceId) => registry.extensionsOf(workspaceId, 'ACTION').filter((item) => item.enabled).map((item) => new ExtensionAction(item, this.handlers));
  }

  private get state() {
    return this.support.state;
  }

  /** Platform code registers controlled handlers by code; tenants can only reference them, never supply code. */
  registerHandler(handlerCode: string, handler: ExtensionRuntimeHandler) {
    this.handlers.set(handlerCode, handler);
  }

  toDto(extension: AutomationExtension) {
    return {
      id: extension.id,
      installationId: extension.installationId,
      kind: extension.kind,
      code: extension.code,
      fullCode: `ext.${extension.code}`,
      name: extension.name,
      description: extension.description,
      schemaVersion: extension.schemaVersion,
      targetTypes: extension.targetTypes,
      configSchema: extension.configSchema,
      payloadSchema: extension.payloadSchema,
      // Only a credential REFERENCE name is ever stored or returned.
      handler: extension.handler,
      permissions: extension.permissions,
      enabled: extension.enabled,
      usedByRules: this.usage(extension).length,
      createdAt: extension.createdAt,
      updatedAt: extension.updatedAt,
    };
  }

  extension(workspaceId: string, extensionId: unknown): AutomationExtension {
    const row = typeof extensionId === 'string' ? this.state.automationExtensions.find((item) => item.id === extensionId && item.workspaceId === workspaceId) : undefined;
    if (!row) throw new AppError('AUTOMATION_EXTENSION_NOT_FOUND', 'Extension was not found.', 404);
    return row;
  }

  /** Rules whose revisions (draft or published) reference the extension. */
  usage(extension: AutomationExtension): string[] {
    const code = `ext.${extension.code}`;
    const ruleIds = new Set<string>();
    for (const revision of this.state.automationRevisions) {
      if (revision.workspaceId !== extension.workspaceId) continue;
      if (revision.triggerCode === code) ruleIds.add(revision.ruleId);
    }
    for (const action of this.state.automationActions) if (action.workspaceId === extension.workspaceId && action.actionCode === code) {
      const revision = this.state.automationRevisions.find((item) => item.id === action.revisionId);
      if (revision) ruleIds.add(revision.ruleId);
    }
    return [...ruleIds];
  }

  list(user: User, workspaceId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.manageExtensions, P.read, P.manage);
    return this.state.automationExtensions.filter((item) => item.workspaceId === workspaceId).sort((a, b) => a.code.localeCompare(b.code)).map((item) => this.toDto(item));
  }

  private parseHandler(kind: ExtensionKind, value: unknown): ExtensionHandler | null {
    if (kind === 'TRIGGER') {
      if (value !== undefined && value !== null) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'A custom trigger has no handler; it is invoked by the authenticated integration.', { field: 'handler' });
      return null;
    }
    if (!isPlainObject(value)) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'A custom action needs a handler.', { field: 'handler' });
    if (value.kind === 'HTTP') {
      const extra = Object.keys(value).filter((key) => !['kind', 'url', 'method', 'secretRef', 'timeoutMs'].includes(key));
      if (extra.length > 0) throw badRequest('AUTOMATION_EXTENSION_INVALID', `Unsupported handler keys: ${extra.join(', ')}. Credentials must be referenced through secretRef.`, { field: 'handler' });
      if (typeof value.url !== 'string') throw badRequest('AUTOMATION_EXTENSION_INVALID', 'handler.url is required.', { field: 'handler.url' });
      try {
        assertSafeUrlShape(value.url, { allowHttp: this.services.allowHttp() });
      } catch (error) {
        throw badRequest('AUTOMATION_EGRESS_BLOCKED', error instanceof Error ? error.message : 'The URL is not allowed.', { field: 'handler.url' });
      }
      if (value.method !== undefined && !['POST', 'PUT', 'PATCH'].includes(String(value.method))) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'handler.method must be POST, PUT or PATCH.', { field: 'handler.method' });
      if (value.secretRef !== undefined && value.secretRef !== null && (typeof value.secretRef !== 'string' || !SECRET_REF.test(value.secretRef))) throw badRequest('AUTOMATION_SECRET_MUST_BE_REFERENCE', 'handler.secretRef must be a credential reference name.', { field: 'handler.secretRef' });
      if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || (value.timeoutMs as number) < 1000 || (value.timeoutMs as number) > 15000)) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'handler.timeoutMs must be between 1000 and 15000.', { field: 'handler.timeoutMs' });
      return { kind: 'HTTP', url: value.url, method: (value.method as 'POST' | 'PUT' | 'PATCH') ?? 'POST', secretRef: (value.secretRef as string | null | undefined) ?? null, timeoutMs: value.timeoutMs as number | undefined };
    }
    if (value.kind === 'REGISTERED') {
      if (typeof value.handlerCode !== 'string' || !CODE_PATTERN.test(value.handlerCode)) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'handler.handlerCode must be a registered handler code.', { field: 'handler.handlerCode' });
      return { kind: 'REGISTERED', handlerCode: value.handlerCode };
    }
    throw badRequest('AUTOMATION_EXTENSION_INVALID', 'handler.kind must be HTTP or REGISTERED.', { field: 'handler.kind' });
  }

  private parseSchema(value: unknown, field: string): SchemaNode | null {
    if (value === undefined || value === null) return null;
    const problems = validateSchemaDefinition(value);
    if (problems.length > 0) throw badRequest('AUTOMATION_EXTENSION_INVALID', `${field} is not a valid restricted schema.`, { field, errors: problems });
    if ((value as SchemaNode).type !== 'object') throw badRequest('AUTOMATION_EXTENSION_INVALID', `${field} must describe an object.`, { field });
    return value as SchemaNode;
  }

  private parseTargets(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !this.registry.targets.has(item))) {
      throw badRequest('AUTOMATION_EXTENSION_INVALID', 'targetTypes must list registered automation targets.', { field: 'targetTypes' });
    }
    return [...new Set(value as string[])];
  }

  private parsePermissions(value: unknown): string[] {
    if (value === undefined) return [];
    const known = new Set<string>(PERMISSION_CATALOG);
    if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== 'string' || !known.has(item))) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'permissions must list known permission keys.', { field: 'permissions' });
    return [...new Set(value as string[])];
  }

  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    const unknown = Object.keys(input).filter((key) => !['kind', 'code', 'installationId', 'name', 'description', 'targetTypes', 'configSchema', 'payloadSchema', 'handler', 'permissions'].includes(key));
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `Unsupported keys: ${unknown.join(', ')}.`, { fields: unknown });
    return this.support.store.atomicSync(() => {
      const kind = input.kind as ExtensionKind;
      if (kind !== 'TRIGGER' && kind !== 'ACTION') throw badRequest('AUTOMATION_EXTENSION_INVALID', 'kind must be TRIGGER or ACTION.', { field: 'kind' });
      if (typeof input.code !== 'string' || !CODE_PATTERN.test(input.code)) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'code must be a stable lowercase identifier (3-64 characters).', { field: 'code' });
      if (typeof input.installationId !== 'string' || !input.installationId.trim() || input.installationId.length > 100) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'installationId is required.', { field: 'installationId' });
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'name is required.', { field: 'name' });
      // Codes are unique per namespace and immutable, so history stays interpretable.
      if (this.state.automationExtensions.some((item) => item.workspaceId === workspaceId && item.kind === kind && item.code === input.code)) throw conflict('AUTOMATION_EXTENSION_CODE_CONFLICT', 'An extension with this code already exists.');
      if (kind === 'TRIGGER' && input.configSchema !== undefined) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'A custom trigger uses payloadSchema, not configSchema.', { field: 'configSchema' });
      if (kind === 'ACTION' && input.payloadSchema !== undefined) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'A custom action uses configSchema, not payloadSchema.', { field: 'payloadSchema' });
      const now = new Date();
      const extension: AutomationExtension = {
        id: this.support.store.id(),
        workspaceId,
        installationId: input.installationId.trim(),
        kind,
        code: input.code,
        name: input.name.trim(),
        description: typeof input.description === 'string' ? input.description.slice(0, 2000) : null,
        schemaVersion: 1,
        targetTypes: this.parseTargets(input.targetTypes),
        configSchema: kind === 'ACTION' ? this.parseSchema(input.configSchema, 'configSchema') : null,
        payloadSchema: kind === 'TRIGGER' ? this.parseSchema(input.payloadSchema, 'payloadSchema') : null,
        handler: this.parseHandler(kind, input.handler),
        permissions: this.parsePermissions(input.permissions),
        enabled: true,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
        createdAt: now,
        updatedAt: now,
      };
      this.state.automationExtensions.push(extension);
      this.support.audit(actor, 'AUTOMATION.EXTENSION_REGISTERED', 'AutomationExtension', extension.id, null, { kind, code: extension.code, installationId: extension.installationId });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_EXTENSION_CHANGED', 'AUTOMATION_EXTENSION', extension.id, { change: 'REGISTERED', kind });
      return this.toDto(extension);
    });
  }

  update(user: User, workspaceId: string, extensionId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    return this.support.store.atomicSync(() => {
      const extension = this.extension(workspaceId, extensionId);
      if (input.code !== undefined && input.code !== extension.code) throw badRequest('AUTOMATION_EXTENSION_CODE_IMMUTABLE', 'An extension code is immutable.');
      if (input.kind !== undefined && input.kind !== extension.kind) throw badRequest('AUTOMATION_EXTENSION_CODE_IMMUTABLE', 'An extension kind cannot change.');
      const unknown = Object.keys(input).filter((key) => !['code', 'kind', 'name', 'description', 'targetTypes', 'configSchema', 'payloadSchema', 'handler', 'permissions'].includes(key));
      if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `Unsupported keys: ${unknown.join(', ')}.`, { fields: unknown });
      const before = this.toDto(extension);
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'name is required.', { field: 'name' });
        extension.name = input.name.trim();
      }
      if (input.description !== undefined) extension.description = typeof input.description === 'string' ? input.description.slice(0, 2000) : null;
      let schemaChanged = false;
      if (input.targetTypes !== undefined) {
        extension.targetTypes = this.parseTargets(input.targetTypes);
        schemaChanged = true;
      }
      if (input.configSchema !== undefined) {
        if (extension.kind !== 'ACTION') throw badRequest('AUTOMATION_EXTENSION_INVALID', 'Only actions have a configSchema.', { field: 'configSchema' });
        extension.configSchema = this.parseSchema(input.configSchema, 'configSchema');
        schemaChanged = true;
      }
      if (input.payloadSchema !== undefined) {
        if (extension.kind !== 'TRIGGER') throw badRequest('AUTOMATION_EXTENSION_INVALID', 'Only triggers have a payloadSchema.', { field: 'payloadSchema' });
        extension.payloadSchema = this.parseSchema(input.payloadSchema, 'payloadSchema');
        schemaChanged = true;
      }
      if (input.handler !== undefined) extension.handler = this.parseHandler(extension.kind, input.handler);
      if (input.permissions !== undefined) extension.permissions = this.parsePermissions(input.permissions);
      if (schemaChanged) extension.schemaVersion += 1;
      extension.updatedAt = new Date();
      extension.updatedByUserId = actor.user.id;
      this.support.audit(actor, 'AUTOMATION.EXTENSION_UPDATED', 'AutomationExtension', extension.id, before, this.toDto(extension));
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_EXTENSION_CHANGED', 'AUTOMATION_EXTENSION', extension.id, { change: 'UPDATED' });
      return this.toDto(extension);
    });
  }

  /** Disabling blocks new use immediately; Rules depending on it are paused visibly and pending jobs fail safely at run time. */
  setEnabled(user: User, workspaceId: string, extensionId: string, enabled: boolean) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    return this.support.store.atomicSync(() => {
      const extension = this.extension(workspaceId, extensionId);
      if (extension.enabled === enabled) return this.toDto(extension);
      extension.enabled = enabled;
      extension.updatedAt = new Date();
      let paused = 0;
      if (!enabled) {
        for (const ruleId of this.usage(extension)) {
          const rule = this.state.automationRules.find((item) => item.id === ruleId);
          if (rule && rule.state === 'ACTIVE') {
            rule.state = 'PAUSED';
            rule.version += 1;
            rule.updatedAt = new Date();
            paused += 1;
            this.support.log(workspaceId, 'WARN', 'AUTOMATION_EXTENSION_DISABLED', `Rule "${rule.name}" was paused because extension ${extension.code} was disabled.`, { ruleId: rule.id });
            this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_RULE_STATE_CHANGED', 'AUTOMATION_RULE', rule.id, { state: 'PAUSED', reason: 'EXTENSION_DISABLED' });
          }
        }
      }
      this.support.audit(actor, enabled ? 'AUTOMATION.EXTENSION_ENABLED' : 'AUTOMATION.EXTENSION_DISABLED', 'AutomationExtension', extension.id, { enabled: !enabled }, { enabled, pausedRules: paused });
      this.support.emit(workspaceId, actor.user.id, 'AUTOMATION_EXTENSION_CHANGED', 'AUTOMATION_EXTENSION', extension.id, { change: enabled ? 'ENABLED' : 'DISABLED' });
      return this.toDto(extension);
    });
  }

  remove(user: User, workspaceId: string, extensionId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    return this.support.store.atomicSync(() => {
      const extension = this.extension(workspaceId, extensionId);
      const used = this.usage(extension);
      if (used.length > 0) throw conflict('AUTOMATION_EXTENSION_IN_USE', 'Rules still reference this extension. Disable it instead of deleting it.', { ruleIds: used });
      this.state.automationExtensions = this.state.automationExtensions.filter((item) => item.id !== extension.id);
      this.support.audit(actor, 'AUTOMATION.EXTENSION_DELETED', 'AutomationExtension', extension.id, { code: extension.code }, null);
      return { id: extension.id, deleted: true };
    });
  }

  // ---- integration credentials ------------------------------------------------------------------------------------------------------------------------

  credentialDto(credential: AutomationCredential) {
    return { id: credential.id, installationId: credential.installationId, name: credential.name, triggerCodes: credential.triggerCodes, isActive: credential.isActive, lastUsedAt: credential.lastUsedAt, createdAt: credential.createdAt, revokedAt: credential.revokedAt };
  }

  listCredentials(user: User, workspaceId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    return this.state.automationCredentials.filter((item) => item.workspaceId === workspaceId).map((item) => this.credentialDto(item));
  }

  /** The secret is returned exactly once; only its hash is stored. */
  createCredential(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    const unknown = Object.keys(input).filter((key) => !['installationId', 'name', 'triggerCodes'].includes(key));
    if (unknown.length > 0) throw badRequest('AUTOMATION_FIELD_NOT_UPDATABLE', `Unsupported keys: ${unknown.join(', ')}.`, { fields: unknown });
    return this.support.store.atomicSync(() => {
      if (typeof input.installationId !== 'string' || !input.installationId.trim()) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'installationId is required.', { field: 'installationId' });
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'name is required.', { field: 'name' });
      const codes = input.triggerCodes === undefined ? [] : input.triggerCodes;
      if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string') || codes.length > 50) throw badRequest('AUTOMATION_EXTENSION_INVALID', 'triggerCodes must list trigger extension codes.', { field: 'triggerCodes' });
      const id = this.support.store.id();
      const secret = `${id}.${randomBytes(32).toString('base64url')}`;
      const credential: AutomationCredential = { id, workspaceId, installationId: input.installationId.trim(), name: input.name.trim(), secretHash: sha256(secret), triggerCodes: (codes as string[]).map((code) => code.replace(/^ext\./, '')), isActive: true, lastUsedAt: null, createdByUserId: actor.user.id, createdAt: new Date(), revokedAt: null };
      this.state.automationCredentials.push(credential);
      this.support.audit(actor, 'AUTOMATION.CREDENTIAL_CREATED', 'AutomationCredential', id, null, { installationId: credential.installationId, name: credential.name });
      return { ...this.credentialDto(credential), secret };
    });
  }

  revokeCredential(user: User, workspaceId: string, credentialId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireWorkspace(actor, P.manageExtensions);
    return this.support.store.atomicSync(() => {
      const credential = this.state.automationCredentials.find((item) => item.id === credentialId && item.workspaceId === workspaceId);
      if (!credential) throw new AppError('AUTOMATION_EXTENSION_NOT_FOUND', 'Credential was not found.', 404);
      if (credential.isActive) {
        credential.isActive = false;
        credential.revokedAt = new Date();
        this.support.audit(actor, 'AUTOMATION.CREDENTIAL_REVOKED', 'AutomationCredential', credential.id, { isActive: true }, { isActive: false });
      }
      return this.credentialDto(credential);
    });
  }

  // ---- authenticated custom trigger invocation ----------------------------------------------------------------------------------------------------------

  /**
   * The workspace, the installation and the caller's identity all come from the credential - never from the request. The
   * payload is validated against the trigger's typed schema and only becomes read-only context for Rule evaluation.
   */
  invokeCustomTrigger(credentialHeader: string | null, triggerCodeRaw: string, body: Json) {
    const secret = credentialHeader?.trim() ?? '';
    const [credentialId] = secret.split('.');
    const credential = credentialId ? this.state.automationCredentials.find((item) => item.id === credentialId) : undefined;
    const expected = credential ? Buffer.from(credential.secretHash) : Buffer.alloc(0);
    const provided = Buffer.from(sha256(secret));
    if (!credential || !credential.isActive || expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw unauthorized('Invalid integration credential.');
    checkRateLimit(credential.id, { scope: 'automation.custom-trigger', limit: 300, windowMs: 60_000 });
    const workspaceId = credential.workspaceId;
    return this.support.store.atomicSync(() => {
      const code = triggerCodeRaw.replace(/^ext\./, '');
      const extension = this.state.automationExtensions.find((item) => item.workspaceId === workspaceId && item.kind === 'TRIGGER' && item.code === code);
      if (!extension || !extension.enabled) throw new AppError('AUTOMATION_TRIGGER_NOT_SUPPORTED', 'Unknown or disabled trigger.', 404);
      if (extension.installationId !== credential.installationId || (credential.triggerCodes.length > 0 && !credential.triggerCodes.includes(code))) {
        throw new AppError('PERMISSION_DENIED', 'This credential cannot invoke this trigger.', 403);
      }
      const unknown = Object.keys(body).filter((key) => !['targetType', 'targetId', 'eventId', 'payload'].includes(key));
      if (unknown.length > 0) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', `Unsupported keys: ${unknown.join(', ')}. The workspace and identity come from the credential.`, { fields: unknown });
      if (typeof body.eventId !== 'string' || !body.eventId.trim() || body.eventId.length > 200) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'eventId (the provider event id) is required.', { field: 'eventId' });
      const targetType = typeof body.targetType === 'string' ? body.targetType : extension.targetTypes.length === 1 ? extension.targetTypes[0] : '';
      if (!extension.targetTypes.includes(targetType)) throw badRequest('AUTOMATION_TRIGGER_NOT_SUPPORTED', 'targetType is not supported by this trigger.', { field: 'targetType', supported: extension.targetTypes });
      if (typeof body.targetId !== 'string') throw badRequest('AUTOMATION_TARGET_NOT_FOUND', 'targetId is required.', { field: 'targetId' });
      // Workspace-scoped load: an id that belongs to another tenant is simply "not found".
      const target = this.registry.targets.get(targetType).load(workspaceId, body.targetId);
      if (!target) throw new AppError('AUTOMATION_TARGET_NOT_FOUND', 'The target record was not found.', 404);
      let payload: Record<string, unknown> | undefined;
      if (body.payload !== undefined) {
        if (!isPlainObject(body.payload) || JSON.stringify(body.payload).length > MAX_PAYLOAD_BYTES) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'payload must be a small object.', { field: 'payload' });
        const problems = extension.payloadSchema ? validateAgainstSchema(extension.payloadSchema, body.payload) : Object.keys(body.payload).map((key) => ({ path: `$.${key}`, code: 'UNKNOWN_PROPERTY', message: 'This trigger declares no payload.' }));
        if (problems.length > 0) throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'The payload does not match the trigger schema.', { errors: problems });
        payload = body.payload;
      } else if (extension.payloadSchema?.required?.length) {
        throw badRequest('AUTOMATION_TRIGGER_PAYLOAD_INVALID', 'payload is required for this trigger.', { field: 'payload' });
      }
      const eventId = `ext:${code}:${body.eventId.trim()}`;
      const context: TriggerContext = {
        eventId,
        eventType: `EXT.${code}`,
        triggerCode: `ext.${code}`,
        workspaceId,
        targetType,
        targetId: body.targetId,
        occurredAt: new Date().toISOString(),
        actor: { type: 'SERVICE', id: credential.id },
        correlationId: eventId,
        depth: 0,
        payload,
      };
      credential.lastUsedAt = new Date();
      let created = 0;
      const candidates = this.engine.activeRules(workspaceId, targetType, `ext.${code}`);
      for (const { rule, revision } of candidates) created += this.engine.matchRule(rule, revision, context, target, { initiator: context.actor });
      return { accepted: true, eventId: body.eventId, matchedRules: candidates.length, jobsCreated: created, duplicate: candidates.length > 0 && created === 0 };
    });
  }
}
