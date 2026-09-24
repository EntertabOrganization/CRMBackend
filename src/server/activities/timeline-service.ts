import type { ActorContext, AccessService } from '../access-service';
import { AuditService } from '../audit-service';
import type { OutboxEvent, User } from '../domain';
import { AppError, badRequest, conflict, fieldValidationFailed } from '../errors';
import { emitDomainEvent } from '../events';
import type { FieldEntityRegistry } from '../fields/entity-registry';
import type { FilePort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import type { ActivityAccessPolicy } from './activity-access';
import { decodeCursor, encodeCursor, fingerprint } from './activity-helpers';
import type { TimelineCategory, TimelineComment, TimelineCommentMention, TimelineEntry } from './types';
import { TIMELINE_CATEGORIES, TIMELINE_PROJECTION_VERSION } from './types';

type Json = Record<string, unknown>;
const TIMELINE_ENTITY_TYPES = ['LEAD', 'CONTACT', 'COMPANY', 'DEAL'];
const MAX_COMMENT = 10_000;
const MAX_MENTIONS = 50;
const MAX_COMMENT_FILES = 20;
const NOISY_CATEGORIES = new Set<TimelineCategory>(['CRM_CHANGE', 'AUTOMATION', 'SYSTEM']);
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type Projection = {
  entityType: string;
  entityId: string;
  category: TimelineCategory;
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  summaryCode: string;
  summaryText: string;
  snapshot: Json;
  actorType: TimelineEntry['actorType'];
};

/** Plain-text comment bodies only: markup is stripped, control characters removed, whitespace normalized. */
export function sanitizeCommentBody(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Timeline = a derived, permission-aware chronological read model plus user comments. Projected entries are rebuildable
 * from durable outbox events and can never be the source of business truth or an authorization bypass.
 */
export class TimelineService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
    private readonly registry: FieldEntityRegistry,
    private readonly activityPolicy: ActivityAccessPolicy,
    private readonly realtime: RealtimeHub,
    private readonly files: () => FilePort,
  ) {}

  private get state() {
    return this.store.state;
  }

  // ---- projection -------------------------------------------------------------------------------------------------

  /**
   * Consumes outbox events that have not been projected yet. Idempotent by construction: every projection carries a
   * stable source-event key that is unique per target record, so a redelivered event can never duplicate an entry.
   */
  projectPending(workspaceId?: string) {
    let projected = 0;
    const pending = this.state.outboxEvents
      .filter((event) => !event.projectedAt && (!workspaceId || event.workspaceId === workspaceId))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (const event of pending) {
      for (const projection of this.mapEvent(event)) projected += this.upsertEntry(event, projection) ? 1 : 0;
      event.projectedAt = new Date();
    }
    return { projected, scanned: pending.length };
  }

  private upsertEntry(event: OutboxEvent, projection: Projection): boolean {
    const duplicate = this.state.crmTimelineEntries.some(
      (entry) =>
        entry.workspaceId === event.workspaceId &&
        entry.entityType === projection.entityType &&
        entry.entityId === projection.entityId &&
        entry.sourceEventId === projection.sourceEventId &&
        entry.projectionKind === 'DEFAULT',
    );
    if (duplicate) return false;
    const actor = event.actorUserId ? this.state.users.find((user) => user.id === event.actorUserId) : undefined;
    const entry: TimelineEntry = {
      id: this.store.id(),
      workspaceId: event.workspaceId,
      entityType: projection.entityType,
      entityId: projection.entityId,
      category: projection.category,
      sourceType: projection.sourceType,
      sourceId: projection.sourceId,
      sourceEventId: projection.sourceEventId,
      projectionKind: 'DEFAULT',
      sourceVersion: typeof event.payload.version === 'number' ? event.payload.version : typeof event.payload.entityVersion === 'number' ? event.payload.entityVersion : null,
      occurredAt: event.occurredAt,
      actorType: projection.actorType,
      actorUserId: event.actorUserId ?? null,
      actorDisplaySnapshot: actor ? `${actor.firstName} ${actor.lastName}`.trim() : null,
      summaryCode: projection.summaryCode,
      summaryTextSnapshot: projection.summaryText,
      presentationSnapshot: projection.snapshot,
      correlationId: event.correlationId ?? null,
      projectionVersion: TIMELINE_PROJECTION_VERSION,
      createdAt: new Date(),
    };
    this.state.crmTimelineEntries.push(entry);
    // Informational only; marked as already consumed so the projector can never loop on its own output.
    emitDomainEvent(this.store, {
      workspaceId: entry.workspaceId,
      eventType: 'TIMELINE_ENTRY_PROJECTED',
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorUserId: entry.actorUserId,
      correlationId: entry.correlationId,
      changes: { timelineEntryId: entry.id, category: entry.category, sourceType: entry.sourceType },
    }).projectedAt = new Date();
    this.realtime.enqueue({
      type: 'TIMELINE_ENTRY_PROJECTED',
      workspaceId: entry.workspaceId,
      data: { entityType: entry.entityType, entityId: entry.entityId, entryId: entry.id },
      audienceUserIds: this.entityReaders(entry.workspaceId, entry.entityType, entry.entityId),
    });
    return true;
  }

  private userName(userId: unknown) {
    if (typeof userId !== 'string') return null;
    const user = this.state.users.find((item) => item.id === userId);
    return user ? `${user.firstName} ${user.lastName}`.trim() : null;
  }

  private stageName(stageId: unknown) {
    if (typeof stageId !== 'string') return null;
    const stage = this.state.crmStages.find((item) => item.id === stageId);
    return stage ? { id: stage.id, name: stage.name } : null;
  }

  /** Maps a durable domain event to the Timeline entries it should produce (meaningful business events only). */
  private mapEvent(event: OutboxEvent): Projection[] {
    const payload = event.payload as Json;
    const type = event.eventType;

    if (type.startsWith('ACTIVITY_')) {
      const meaningful: Record<string, { summaryCode: string; verb: string }> = {
        ACTIVITY_CREATED: { summaryCode: 'ACTIVITY_CREATED', verb: 'planned' },
        ACTIVITY_COMPLETED: { summaryCode: 'ACTIVITY_COMPLETED', verb: 'completed' },
        ACTIVITY_CANCELLED: { summaryCode: 'ACTIVITY_CANCELLED', verb: 'cancelled' },
        ACTIVITY_REOPENED: { summaryCode: 'ACTIVITY_REOPENED', verb: 'reopened' },
        ACTIVITY_DELETED: { summaryCode: 'ACTIVITY_DELETED', verb: 'deleted' },
        ACTIVITY_RESTORED: { summaryCode: 'ACTIVITY_RESTORED', verb: 'restored' },
      };
      let descriptor = meaningful[type];
      // Minor edits stay in Audit; only a genuine reschedule is timeline-worthy.
      if (type === 'ACTIVITY_UPDATED' && payload.rescheduled === true) descriptor = { summaryCode: 'ACTIVITY_RESCHEDULED', verb: 'rescheduled' };
      // The creation event already names the initial assignee.
      if (type === 'ACTIVITY_REASSIGNED' && payload.initialAssignment !== true) descriptor = { summaryCode: 'ACTIVITY_REASSIGNED', verb: 'reassigned' };
      if (!descriptor) return [];
      const provider = payload.provider === true;
      const bindings = Array.isArray(payload.bindings) ? (payload.bindings as Array<{ entityType: string; entityId: string }>) : [];
      const typeCode = String(payload.typeCode ?? 'ACTIVITY');
      const subject = String(payload.subject ?? '');
      const snapshot: Json = this.compact({
        activityType: typeCode,
        subject,
        status: payload.to ?? payload.status ?? undefined,
        responsibleDisplayName: this.userName(payload.to ?? payload.responsibleUserId),
        resultSummary: payload.resultSummary || undefined,
        reason: payload.reason || undefined,
        previousDeadline: (payload.previous as Json | undefined)?.deadline,
        newDeadline: (payload.next as Json | undefined)?.deadline,
        fromDisplayName: type === 'ACTIVITY_REASSIGNED' ? this.userName(payload.from) : undefined,
        activityId: event.entityId,
      });
      const sourceEventId = provider ? `provider:${payload.origin}:${payload.externalId}` : event.id;
      return bindings.map((binding) => ({
        entityType: binding.entityType,
        entityId: binding.entityId,
        category: provider ? 'COMMUNICATION' : 'ACTIVITY',
        sourceType: 'ACTIVITY',
        sourceId: event.entityId,
        sourceEventId,
        summaryCode: descriptor.summaryCode,
        summaryText: `${typeCode} ${descriptor.verb}${subject ? `: ${subject}` : ''}`,
        snapshot,
        actorType: provider ? ('PROVIDER' as const) : event.actorUserId ? ('USER' as const) : ('SYSTEM' as const),
      }));
    }

    if (type === 'CRM.LEAD.CREATED' || type === 'CRM.DEAL.CREATED' || type === 'CRM.CONTACT.CREATED' || type === 'CRM.COMPANY.CREATED') {
      const label = this.recordLabel(event.entityType, event.entityId);
      return [this.crmProjection(event, 'CRM_CHANGE', 'CRM_RECORD_CREATED', `${this.entityLabel(event.entityType)} created${label ? `: ${label}` : ''}`, { recordLabel: label })];
    }
    if (type === 'CRM.LEAD.STAGE_CHANGED' || type === 'CRM.DEAL.STAGE_CHANGED') {
      const from = this.stageName(payload.fromStageId);
      const to = this.stageName(payload.toStageId);
      // The initial placement into the default stage is not a customer-visible change.
      if (!from) return [];
      return [this.crmProjection(event, 'STAGE_CHANGE', 'STAGE_CHANGED', `Stage changed: ${from.name} → ${to?.name ?? ''}`, { fromStage: from, toStage: to })];
    }
    if (/^CRM\.(LEAD|DEAL|CONTACT|COMPANY)\.ASSIGNED$/.test(type)) {
      return [
        this.crmProjection(event, 'CRM_CHANGE', 'RESPONSIBLE_CHANGED', `Responsible user changed to ${this.userName(payload.toUserId) ?? 'another user'}`, {
          fromDisplayName: this.userName(payload.fromUserId),
          toDisplayName: this.userName(payload.toUserId),
        }),
      ];
    }
    if (type === 'CRM.LEAD.CONVERTED') {
      const targets: Projection[] = [this.crmProjection(event, 'CRM_CHANGE', 'LEAD_CONVERTED', 'Lead converted', { contactId: payload.contactId ?? null, dealId: payload.dealId ?? null })];
      for (const [key, entityType] of [['contactId', 'CONTACT'], ['companyId', 'COMPANY'], ['dealId', 'DEAL']] as const) {
        const id = payload[key];
        if (typeof id === 'string') targets.push({ ...targets[0], entityType, entityId: id, summaryText: 'Created from a converted lead', snapshot: { leadId: event.entityId } });
      }
      return targets;
    }
    return [];
  }

  /** Drops empty keys so snapshots stay small and JSON-stable. */
  private compact(snapshot: Json): Json {
    return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  }

  private entityLabel(entityType: string) {
    return entityType.charAt(0) + entityType.slice(1).toLowerCase();
  }

  private recordLabel(entityType: string, entityId: string) {
    const s = this.state;
    if (entityType === 'LEAD') return s.crmLeads.find((item) => item.id === entityId)?.title ?? null;
    if (entityType === 'DEAL') return s.crmDeals.find((item) => item.id === entityId)?.title ?? null;
    if (entityType === 'CONTACT') return s.crmContacts.find((item) => item.id === entityId)?.displayName ?? null;
    if (entityType === 'COMPANY') return s.crmCompanies.find((item) => item.id === entityId)?.name ?? null;
    return null;
  }

  private crmProjection(event: OutboxEvent, category: TimelineCategory, summaryCode: string, summaryText: string, snapshot: Json): Projection {
    return {
      entityType: event.entityType,
      entityId: event.entityId,
      category,
      sourceType: 'CRM',
      sourceId: event.entityId,
      sourceEventId: event.id,
      summaryCode,
      summaryText,
      snapshot,
      actorType: event.actorUserId ? 'USER' : 'SYSTEM',
    };
  }

  /**
   * Rebuilds projected entries from durable outbox history. User comments live in their own table and are never
   * touched; entries whose source event is no longer available are kept because they cannot be regenerated.
   */
  rebuild(workspaceId: string, scope: { entityType?: string; entityId?: string; from?: Date; to?: Date } = {}) {
    const events = this.state.outboxEvents.filter(
      (event) =>
        event.workspaceId === workspaceId &&
        (!scope.from || event.occurredAt >= scope.from) &&
        (!scope.to || event.occurredAt <= scope.to),
    );
    const eventIds = new Set(events.map((event) => event.id));
    const providerKeys = new Set(
      events.filter((event) => (event.payload as Json).provider === true).map((event) => `provider:${(event.payload as Json).origin}:${(event.payload as Json).externalId}`),
    );
    const before = this.state.crmTimelineEntries.length;
    this.state.crmTimelineEntries = this.state.crmTimelineEntries.filter((entry) => {
      if (entry.workspaceId !== workspaceId) return true;
      if (scope.entityType && entry.entityType !== scope.entityType) return true;
      if (scope.entityId && entry.entityId !== scope.entityId) return true;
      return !(eventIds.has(entry.sourceEventId) || providerKeys.has(entry.sourceEventId));
    });
    const deleted = before - this.state.crmTimelineEntries.length;
    for (const event of events) if (event.eventType !== 'TIMELINE_ENTRY_PROJECTED') event.projectedAt = null;
    const result = this.projectPending(workspaceId);
    return { deleted, reprojected: result.projected, scanned: result.scanned };
  }

  // ---- read ---------------------------------------------------------------------------------------------------------

  private assertTarget(actor: ActorContext, entityType: string, entityId: string) {
    const type = entityType.toUpperCase();
    // Missing, foreign and unauthorized records are indistinguishable to the caller.
    if (!TIMELINE_ENTITY_TYPES.includes(type) || !this.registry.has(type) || !this.access.canAccessCrmRecord(actor, type, entityId, 'read')) {
      throw new AppError('TIMELINE_ACCESS_FORBIDDEN', 'You do not have access to this timeline.', 403);
    }
    return type;
  }

  getTimeline(user: User, workspaceId: string, entityTypeRaw: string, entityId: string, searchParams: URLSearchParams) {
    const actor = this.access.actor(user, workspaceId);
    const entityType = this.assertTarget(actor, entityTypeRaw, entityId);
    this.access.requireScope(actor, 'timeline.read');

    const q = (key: string) => searchParams.get(key) ?? undefined;
    const categories = q('category')?.split(',').map((item) => item.trim()).filter(Boolean);
    for (const category of categories ?? []) if (!(TIMELINE_CATEGORIES as readonly string[]).includes(category)) throw badRequest('CRM_QUERY_INVALID', `Unknown category ${category}.`);
    const from = q('from') ? Date.parse(q('from')!) : undefined;
    const to = q('to') ? Date.parse(q('to')!) : undefined;
    if ((from !== undefined && Number.isNaN(from)) || (to !== undefined && Number.isNaN(to))) throw badRequest('CRM_QUERY_INVALID', 'from/to must be ISO timestamps.');
    const actorFilter = q('actorUserId');
    const sourceType = q('sourceType');
    const limit = Math.min(Math.max(Number(q('limit') ?? '50') || 50, 1), 100);
    const group = q('group') === 'true';

    type Item = { kind: 'ENTRY' | 'COMMENT'; id: string; occurredAt: Date; category: TimelineCategory; actorUserId: string | null; sourceType: string; payload: Json };
    const items: Item[] = [];
    for (const entry of this.state.crmTimelineEntries) {
      if (entry.workspaceId !== workspaceId || entry.entityType !== entityType || entry.entityId !== entityId) continue;
      items.push({ kind: 'ENTRY', id: entry.id, occurredAt: entry.occurredAt, category: entry.category, actorUserId: entry.actorUserId ?? null, sourceType: entry.sourceType, payload: this.entryDto(actor, entry) });
    }
    for (const comment of this.state.crmTimelineComments) {
      if (comment.workspaceId !== workspaceId || comment.entityType !== entityType || comment.entityId !== entityId) continue;
      items.push({ kind: 'COMMENT', id: comment.id, occurredAt: comment.createdAt, category: 'COMMENT', actorUserId: comment.authorUserId, sourceType: 'COMMENT', payload: this.commentDto(actor, comment) });
    }
    let rows = items;
    if (categories) rows = rows.filter((item) => categories.includes(item.category));
    if (actorFilter) rows = rows.filter((item) => item.actorUserId === actorFilter);
    if (sourceType) rows = rows.filter((item) => item.sourceType === sourceType);
    if (from !== undefined) rows = rows.filter((item) => item.occurredAt.getTime() >= from);
    if (to !== undefined) rows = rows.filter((item) => item.occurredAt.getTime() <= to);

    // Newest first; the id is a stable tie-breaker so equal timestamps paginate without gaps or repeats.
    const keyOf = (item: Item) => `${String(9_999_999_999_999 - item.occurredAt.getTime()).padStart(13, '0')}|${item.id}`;
    const keyed = rows.map((item) => ({ item, key: keyOf(item) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cursor = decodeCursor(q('cursor'));
    const after = cursor ? keyed.filter((row) => row.key > cursor.key) : keyed;
    const page = after.slice(0, limit);
    const hasMore = after.length > limit;

    let data: Json[] = page.map((row) => ({ kind: row.item.kind, ...row.item.payload }));
    if (group) data = this.collapse(page.map((row) => row.item), data);
    return {
      data,
      meta: { limit, hasMore, nextCursor: hasMore ? encodeCursor({ key: page[page.length - 1].key }) : null },
    };
  }

  /** Display-only grouping of adjacent noisy entries. The underlying entries are untouched. */
  private collapse(items: Array<{ kind: string; category: TimelineCategory; actorUserId: string | null; sourceType: string; payload: Json }>, data: Json[]): Json[] {
    const out: Json[] = [];
    let lastKey: string | null = null;
    items.forEach((item, index) => {
      const key = item.kind === 'ENTRY' && NOISY_CATEGORIES.has(item.category) ? `${item.category}|${item.sourceType}|${item.actorUserId}|${item.payload.summaryCode}` : null;
      const previous = out[out.length - 1];
      if (key && key === lastKey && previous) {
        previous.collapsedCount = ((previous.collapsedCount as number | undefined) ?? 1) + 1;
        (previous.collapsedIds as string[]).push(item.payload.id as string);
        return;
      }
      lastKey = key;
      const row = { ...data[index] };
      if (key) row.collapsedIds = [];
      out.push(row);
    });
    return out;
  }

  private entryDto(actor: ActorContext, entry: TimelineEntry): Json {
    // Links to the source are only offered while the reader can currently open the source object.
    let sourceLink: Json | null = null;
    if (entry.sourceType === 'ACTIVITY') {
      const activity = this.state.crmActivities.find((item) => item.id === entry.sourceId && item.workspaceId === entry.workspaceId);
      if (activity && !activity.isDeleted && this.activityPolicy.canRead(actor, activity)) sourceLink = { type: 'ACTIVITY', id: activity.id };
    } else if (entry.sourceType === 'CRM' && this.access.canAccessCrmRecord(actor, entry.entityType, entry.entityId, 'read')) {
      sourceLink = { type: entry.entityType, id: entry.entityId };
    }
    const snapshot = { ...entry.presentationSnapshot };
    // The Activity id inside the snapshot is a link, so it follows the same visibility rule as sourceLink.
    if (!sourceLink) delete snapshot.activityId;
    return {
      id: entry.id,
      entityType: entry.entityType,
      entityId: entry.entityId,
      category: entry.category,
      sourceType: entry.sourceType,
      occurredAt: entry.occurredAt,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      actorDisplayName: entry.actorDisplaySnapshot ?? null,
      summaryCode: entry.summaryCode,
      summary: entry.summaryTextSnapshot ?? null,
      presentationSnapshot: snapshot,
      sourceLink,
      correlationId: entry.correlationId ?? null,
    };
  }

  // ---- comments -------------------------------------------------------------------------------------------------------------

  private commentDto(actor: ActorContext, comment: TimelineComment): Json {
    const mentions = this.state.crmTimelineCommentMentions.filter((item) => item.commentId === comment.id).map((item) => ({ userId: item.userId }));
    const author = this.state.users.find((item) => item.id === comment.authorUserId);
    const base: Json = {
      id: comment.id,
      entityType: comment.entityType,
      entityId: comment.entityId,
      category: 'COMMENT',
      linkedActivityId: null as string | null,
      authorUserId: comment.authorUserId,
      authorDisplayName: author ? `${author.firstName} ${author.lastName}`.trim() : null,
      occurredAt: comment.createdAt,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      version: comment.version,
      isDeleted: comment.isDeleted,
    };
    if (comment.linkedActivityId) {
      const activity = this.state.crmActivities.find((item) => item.id === comment.linkedActivityId);
      base.linkedActivityId = activity && !activity.isDeleted && this.activityPolicy.canRead(actor, activity) ? comment.linkedActivityId : null;
    }
    if (comment.isDeleted) return { ...base, body: null, fileIds: [], mentions: [] };
    return { ...base, body: comment.body, fileIds: comment.fileIds, mentions, edited: comment.version > 1 };
  }

  private comment(workspaceId: string, commentId: string): TimelineComment {
    const comment = this.state.crmTimelineComments.find((item) => item.id === commentId && item.workspaceId === workspaceId);
    if (!comment) throw new AppError('TIMELINE_COMMENT_NOT_FOUND', 'Comment was not found.', 404);
    return comment;
  }

  private parseMentions(actor: ActorContext, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_MENTIONS) throw badRequest('TIMELINE_MENTION_INVALID', `mentions must be an array of at most ${MAX_MENTIONS} items.`);
    const ids = [...new Set((raw as unknown[]).map((item) => (typeof item === 'string' ? item : (item as { userId?: string })?.userId)))];
    for (const id of ids) {
      // Stable user ids only; free-text @names are never trusted.
      if (typeof id !== 'string' || !this.access.isActiveMember(actor.workspaceId, id)) {
        throw new AppError('TIMELINE_MENTION_INVALID', 'Every mention must reference an active member of this workspace.', 400);
      }
    }
    return ids as string[];
  }

  private parseFiles(actor: ActorContext, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_COMMENT_FILES || raw.some((id) => typeof id !== 'string')) throw badRequest('TIMELINE_FILE_INVALID', `fileIds must be an array of at most ${MAX_COMMENT_FILES} file ids.`);
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))];
    for (const id of ids) {
      const check = this.files().check(actor.workspaceId, actor, id);
      if (check === 'UNAVAILABLE') throw new AppError('FILES_UNAVAILABLE', 'File attachments are not available yet.', 400);
      if (check !== 'OK') throw new AppError('FIELD_REFERENCE_INVALID', 'A referenced file is not available.', 400);
    }
    return ids;
  }

  private linkedActivity(actor: ActorContext, entityType: string, entityId: string, raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const activity = typeof raw === 'string' ? this.state.crmActivities.find((item) => item.id === raw && item.workspaceId === actor.workspaceId && !item.isDeleted) : undefined;
    const bound = activity ? this.activityPolicy.bindingsOf(activity.id).some((binding) => binding.entityType === entityType && binding.entityId === entityId) : false;
    if (!activity || !this.activityPolicy.canRead(actor, activity) || !bound) throw badRequest('TIMELINE_LINKED_ACTIVITY_INVALID', 'The linked activity is not available for this record.');
    return activity.id;
  }

  async createComment(user: User, workspaceId: string, entityTypeRaw: string, entityId: string, input: Json, headerKey?: string) {
    const actor = this.access.actor(user, workspaceId);
    const entityType = this.assertTarget(actor, entityTypeRaw, entityId);
    this.access.requireScope(actor, 'timeline.comment');
    const key = (input.idempotencyKey as string | undefined) ?? headerKey;
    const operation = `crm.timeline.comment.create:${entityType}:${entityId}`;
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > 200)) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string (max 200 characters).');
    const hash = fingerprint(input);
    if (key) {
      const existing = this.state.idempotencyRecords.find(
        (item) => item.workspaceId === workspaceId && item.actorUserId === user.id && item.operation === operation && item.idempotencyKey === key && item.expiresAt > new Date(),
      );
      if (existing) {
        if (existing.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request.', 409);
        return this.commentDto(actor, this.comment(workspaceId, (existing.response as { commentId: string }).commentId)) as Json;
      }
    }
    const created = this.store.atomicSync(() => {
      if (typeof input.body !== 'string') throw fieldValidationFailed({ body: [{ code: 'REQUIRED', message: 'body is required.' }] });
      const body = sanitizeCommentBody(input.body);
      // Files-only comments are not enabled: the Files module is not wired yet, so a text body is always required.
      if (!body) throw fieldValidationFailed({ body: [{ code: 'REQUIRED', message: 'body cannot be empty.' }] });
      if (body.length > MAX_COMMENT) throw fieldValidationFailed({ body: [{ code: 'MAX_LENGTH', message: `body must be at most ${MAX_COMMENT} characters.` }] });
      const fileIds = this.parseFiles(actor, input.fileIds);
      const mentions = this.parseMentions(actor, input.mentions);
      const linkedActivityId = this.linkedActivity(actor, entityType, entityId, input.linkedActivityId);
      const now = new Date();
      const comment: TimelineComment = {
        id: this.store.id(),
        workspaceId,
        entityType,
        entityId,
        linkedActivityId,
        authorUserId: user.id,
        body,
        fileIds,
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.state.crmTimelineComments.push(comment);
      this.saveMentions(comment, mentions);
      new AuditService(this.store).write({ workspaceId, actorUserId: user.id, action: 'TIMELINE.COMMENT_CREATED', entityType: 'CrmTimelineComment', entityId: comment.id, afterData: { entityType, entityId, length: body.length, mentions: mentions.length, files: fileIds.length } });
      emitDomainEvent(this.store, { workspaceId, eventType: 'TIMELINE_COMMENT_CREATED', entityType, entityId, actorUserId: user.id, changes: { commentId: comment.id, mentions: mentions.length }, idempotencyKey: key ?? null });
      this.emitMentions(actor, comment, mentions);
      this.hint('TIMELINE_COMMENT_CREATED', comment);
      if (key) {
        this.state.idempotencyRecords.push({ id: this.store.id(), workspaceId, actorUserId: user.id, operation, idempotencyKey: key, requestHash: hash, response: { commentId: comment.id }, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS), createdAt: now });
      }
      return comment;
    });
    return this.commentDto(actor, created) as Json;
  }

  private saveMentions(comment: TimelineComment, userIds: string[]) {
    this.state.crmTimelineCommentMentions = this.state.crmTimelineCommentMentions.filter((item) => item.commentId !== comment.id);
    const now = new Date();
    this.state.crmTimelineCommentMentions.push(
      ...userIds.map((userId): TimelineCommentMention => ({ id: this.store.id(), workspaceId: comment.workspaceId, commentId: comment.id, userId, createdAt: now })),
    );
  }

  /** A mention is a notification reference only. It never adds the user to the record, and says whether they could open it. */
  private emitMentions(actor: ActorContext, comment: TimelineComment, userIds: string[], already: string[] = []) {
    for (const userId of userIds.filter((id) => !already.includes(id))) {
      const mentioned = this.state.users.find((item) => item.id === userId);
      let canAccessRecord = false;
      if (mentioned) {
        try {
          canAccessRecord = this.access.canAccessCrmRecord(this.access.actor(mentioned, comment.workspaceId), comment.entityType, comment.entityId, 'read');
        } catch {
          canAccessRecord = false;
        }
      }
      emitDomainEvent(this.store, {
        workspaceId: comment.workspaceId,
        eventType: 'TIMELINE_COMMENT_MENTIONED',
        entityType: comment.entityType,
        entityId: comment.entityId,
        actorUserId: actor.user.id,
        changes: { commentId: comment.id, mentionedUserId: userId, canAccessRecord },
      });
    }
  }

  getComment(user: User, workspaceId: string, commentId: string) {
    const actor = this.access.actor(user, workspaceId);
    const comment = this.comment(workspaceId, commentId);
    this.assertTarget(actor, comment.entityType, comment.entityId);
    this.access.requireScope(actor, 'timeline.read');
    return this.commentDto(actor, comment);
  }

  updateComment(user: User, workspaceId: string, commentId: string, input: Json) {
    const actor = this.access.actor(user, workspaceId);
    return this.store.atomicSync(() => {
      const comment = this.comment(workspaceId, commentId);
      this.assertTarget(actor, comment.entityType, comment.entityId);
      if (comment.isDeleted) throw new AppError('TIMELINE_COMMENT_NOT_FOUND', 'Comment was not found.', 404);
      const scope = this.access.scopeFor(actor, 'timeline.comment_edit');
      if (!scope || !this.access.scopeCoversUser(scope, actor.user.id, comment.authorUserId, workspaceId)) {
        throw new AppError('TIMELINE_COMMENT_EDIT_FORBIDDEN', 'You are not allowed to edit this comment.', 403);
      }
      if (typeof input.expectedVersion !== 'number') throw badRequest('TIMELINE_COMMENT_VERSION_REQUIRED', 'expectedVersion is required.');
      if (comment.version !== input.expectedVersion) throw conflict('TIMELINE_COMMENT_VERSION_CONFLICT', 'The comment changed after you loaded it.', { currentVersion: comment.version });
      const before = { length: comment.body.length, files: comment.fileIds.length, version: comment.version };
      if (input.body !== undefined) {
        if (typeof input.body !== 'string') throw fieldValidationFailed({ body: [{ code: 'INVALID_TYPE', message: 'body must be a string.' }] });
        const body = sanitizeCommentBody(input.body);
        if (!body) throw fieldValidationFailed({ body: [{ code: 'REQUIRED', message: 'body cannot be empty.' }] });
        if (body.length > MAX_COMMENT) throw fieldValidationFailed({ body: [{ code: 'MAX_LENGTH', message: `body must be at most ${MAX_COMMENT} characters.` }] });
        comment.body = body;
      }
      if (input.fileIds !== undefined) comment.fileIds = this.parseFiles(actor, input.fileIds);
      if (input.mentions !== undefined) {
        const previous = this.state.crmTimelineCommentMentions.filter((item) => item.commentId === comment.id).map((item) => item.userId);
        const next = this.parseMentions(actor, input.mentions);
        this.saveMentions(comment, next);
        this.emitMentions(actor, comment, next, previous);
      }
      comment.version += 1;
      comment.updatedAt = new Date();
      new AuditService(this.store).write({ workspaceId, actorUserId: actor.user.id, action: 'TIMELINE.COMMENT_UPDATED', entityType: 'CrmTimelineComment', entityId: comment.id, beforeData: before, afterData: { length: comment.body.length, files: comment.fileIds.length, version: comment.version } });
      emitDomainEvent(this.store, { workspaceId, eventType: 'TIMELINE_COMMENT_UPDATED', entityType: comment.entityType, entityId: comment.entityId, actorUserId: actor.user.id, changes: { commentId: comment.id, version: comment.version } });
      this.hint('TIMELINE_COMMENT_UPDATED', comment);
      return this.commentDto(actor, comment);
    });
  }

  deleteComment(user: User, workspaceId: string, commentId: string) {
    const actor = this.access.actor(user, workspaceId);
    return this.store.atomicSync(() => {
      const comment = this.comment(workspaceId, commentId);
      this.assertTarget(actor, comment.entityType, comment.entityId);
      if (comment.isDeleted) return this.commentDto(actor, comment);
      const scope = this.access.scopeFor(actor, 'timeline.comment_delete');
      if (!scope || !this.access.scopeCoversUser(scope, actor.user.id, comment.authorUserId, workspaceId)) {
        throw new AppError('TIMELINE_COMMENT_DELETE_FORBIDDEN', 'You are not allowed to delete this comment.', 403);
      }
      // Soft delete only: the row (and audit evidence) stays; the API stops returning the removed content.
      comment.isDeleted = true;
      comment.deletedAt = new Date();
      comment.deletedByUserId = actor.user.id;
      comment.version += 1;
      comment.updatedAt = new Date();
      new AuditService(this.store).write({ workspaceId, actorUserId: actor.user.id, action: 'TIMELINE.COMMENT_DELETED', entityType: 'CrmTimelineComment', entityId: comment.id, beforeData: { length: comment.body.length }, afterData: { isDeleted: true } });
      emitDomainEvent(this.store, { workspaceId, eventType: 'TIMELINE_COMMENT_DELETED', entityType: comment.entityType, entityId: comment.entityId, actorUserId: actor.user.id, changes: { commentId: comment.id } });
      this.hint('TIMELINE_COMMENT_DELETED', comment);
      return this.commentDto(actor, comment);
    });
  }

  // ---- realtime -----------------------------------------------------------------------------------------------------------------

  private hint(type: string, comment: TimelineComment) {
    this.realtime.enqueue({
      type,
      workspaceId: comment.workspaceId,
      data: { entityType: comment.entityType, entityId: comment.entityId, commentId: comment.id, version: comment.version },
      audienceUserIds: this.entityReaders(comment.workspaceId, comment.entityType, comment.entityId),
    });
  }

  private entityReaders(workspaceId: string, entityType: string, entityId: string): string[] {
    const readers: string[] = [];
    for (const userId of this.access.activeMemberIds(workspaceId)) {
      const user = this.state.users.find((item) => item.id === userId && !item.isDeleted);
      if (!user) continue;
      try {
        if (this.access.canAccessCrmRecord(this.access.actor(user, workspaceId), entityType, entityId, 'read')) readers.push(userId);
      } catch {
        // not a usable member
      }
    }
    return readers;
  }

}
