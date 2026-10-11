import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../access-service';
import { AppError, forbidden, isAppError } from '../../errors';
import { Body, type CollabSupport, isUuid, notFoundError, pageOf, validationError } from '../support';
import type { CalendarEventService } from './event-service';
import type { CalendarEvent } from './event-types';
import { parseIcs, serializeIcs, type IcsEvent } from './ics';
import type { CalendarPolicy } from './policy';
import type { CalendarRecurrenceService } from './recurrence-service';
import { EnvironmentCalendarSyncProvider, type CalendarSyncProvider } from './sync-provider';
import type { CalendarSyncConflict, CalendarSyncConnection, CalendarSyncMapping, ExternalCalendarEvent, OutboundCalendarEvent } from './sync-types';

const LEASE_MS = 300_000;
export type ConnectTicket = { connectionId: string; workspaceId: string; userId: string; calendarId: string; provider: 'GOOGLE' | 'MICROSOFT'; name: string;
  authorizationCode: string; redirectUri: string; externalCalendarId: string | null };
export type SyncTicket = { connectionId: string; workspaceId: string; token: string; provider: 'GOOGLE' | 'MICROSOFT'; credentialRef: string; externalCalendarId: string;
  cursor: string | null; known: Record<string, string | null>; outbound: Array<{ mappingId: string | null; externalEventId: string | null; event: OutboundCalendarEvent }> };
export type SyncOutcome = { pulled: ExternalCalendarEvent[]; nextCursor: string; pushed: Array<{ localEventId: string; localVersion: number; mappingId: string | null; externalEventId: string; etag: string }> };

/**
 * Provider-neutral calendar sync. Stable mappings (connection, external calendar, external event) prevent duplicate Events;
 * provider echoes are suppressed by etag/version metadata; concurrent local and external edits become explicit conflicts.
 * Provider I/O runs between committed state units; a lease fences overlapping sync runs.
 */
export class CalendarSyncService {
  private provider: CalendarSyncProvider = new EnvironmentCalendarSyncProvider();
  constructor(private readonly support: CollabSupport, private readonly policy: CalendarPolicy, private readonly events: CalendarEventService,
    private readonly recurrence: CalendarRecurrenceService) {}
  configure(provider: CalendarSyncProvider) { this.provider = provider; }
  syncProvider() { return this.provider; }
  private get state() { return this.support.state; }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  view(row: CalendarSyncConnection) {
    const { claimId, leaseExpiresAt, ...rest } = row;
    return { ...rest, openConflictCount: this.state.calendarSyncConflicts.filter(item => item.connectionId === row.id && item.status === 'OPEN').length,
      mappingCount: this.state.calendarSyncMappings.filter(item => item.connectionId === row.id).length, syncInProgress: Boolean(leaseExpiresAt && leaseExpiresAt > this.support.now()) };
  }
  private connection(actor: ActorContext, id: string, permission = 'calendar_sync.read') {
    this.support.require(actor, permission);
    const row = isUuid(id) ? this.state.calendarSyncConnections.find(item => item.id === id.toLowerCase() && item.workspaceId === actor.workspaceId &&
      (item.userId === actor.user.id || actor.role.isOwnerRole && permission === 'calendar_sync.read')) : undefined;
    if (!row) throw notFoundError('CALENDAR_SYNC_CONNECTION_NOT_FOUND', 'Calendar sync connection');
    const calendar = this.state.calendars.find(item => item.id === row.calendarId && item.workspaceId === actor.workspaceId);
    if (!calendar || !this.policy.level(actor, calendar)) throw notFoundError('CALENDAR_SYNC_CONNECTION_NOT_FOUND', 'Calendar sync connection');
    return row;
  }
  list(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'calendar_sync.read');
    const rows = this.state.calendarSyncConnections.filter(row => row.workspaceId === actor.workspaceId && (row.userId === actor.user.id || actor.role.isOwnerRole) &&
      this.state.calendars.some(calendar => calendar.id === row.calendarId && this.policy.level(actor, calendar))).map(row => this.view(row));
    return pageOf(rows, query, { searchable: ['name'], filterable: ['provider', 'status', 'calendarId', 'userId'], sortable: ['createdAt', 'lastSyncedAt', 'name'], defaultSort: 'createdAt', defaultOrder: 'desc' });
  }
  get(actor: ActorContext, id: string) { return this.view(this.connection(actor, id)); }
  mappings(actor: ActorContext, id: string, query: URLSearchParams) {
    const connection = this.connection(actor, id);
    const rows = this.state.calendarSyncMappings.filter(row => row.connectionId === connection.id).map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['localEventId', 'externalEventId', 'lastDirection'], sortable: ['lastSyncedAt', 'createdAt'], defaultSort: 'lastSyncedAt', defaultOrder: 'desc' });
  }
  private ownerActor(connection: CalendarSyncConnection) {
    const user = this.state.users.find(row => row.id === connection.userId);
    if (!user || !this.support.isEligibleUser(connection.workspaceId, user.id)) throw new AppError('CALENDAR_SYNC_AUTH_REQUIRED', 'The connection owner is no longer active.', 409);
    return this.support.access.actor(user, connection.workspaceId);
  }
  private targetCalendar(actor: ActorContext, calendarId: string) {
    const calendar = this.policy.calendar(actor, calendarId);
    this.policy.requireLevel(actor, calendar, 'CREATE', 'event.create');
    this.policy.assertWritable(calendar);
    return calendar;
  }

  // ---- connect (staged) -----------------------------------------------------------------------------------------------

  reserveConnect(actor: ActorContext, provider: 'GOOGLE' | 'MICROSOFT', body: Body): ConnectTicket {
    this.support.require(actor, 'calendar_sync.connect');
    body.only(['calendarId', 'authorizationCode', 'redirectUri', 'externalCalendarId', 'name']);
    const calendar = this.targetCalendar(actor, body.uuid('calendarId', { required: true }));
    const redirectUri = body.str('redirectUri', { required: true, max: 2000 });
    let url: URL;
    try { url = new URL(redirectUri); } catch { throw validationError('redirectUri', 'redirectUri must be an absolute HTTPS URL.'); }
    if (url.protocol !== 'https:') throw validationError('redirectUri', 'redirectUri must be an absolute HTTPS URL.');
    return { connectionId: randomUUID(), workspaceId: actor.workspaceId, userId: actor.user.id, calendarId: calendar.id, provider,
      name: body.str('name', { max: 200 }) ?? `${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} Calendar`,
      authorizationCode: body.str('authorizationCode', { required: true, max: 4096 }), redirectUri, externalCalendarId: body.str('externalCalendarId', { max: 500 }) ?? null };
  }
  async exchange(ticket: ConnectTicket, signal?: AbortSignal) {
    return this.provider.connect({ connectionId: ticket.connectionId, workspaceId: ticket.workspaceId, provider: ticket.provider, userId: ticket.userId,
      authorizationCode: ticket.authorizationCode, redirectUri: ticket.redirectUri, externalCalendarId: ticket.externalCalendarId }, signal);
  }
  completeConnect(actor: ActorContext, ticket: ConnectTicket, result: { credentialRef: string; externalCalendarId: string; accountEmail: string | null }) {
    if (actor.user.id !== ticket.userId || actor.workspaceId !== ticket.workspaceId) throw forbidden('The connection must be completed by its owner.');
    this.support.require(actor, 'calendar_sync.connect');
    this.targetCalendar(actor, ticket.calendarId);
    const existing = this.state.calendarSyncConnections.find(row => row.id === ticket.connectionId);
    if (existing) return this.view(existing);
    const now = this.support.now();
    const row: CalendarSyncConnection = { id: ticket.connectionId, workspaceId: ticket.workspaceId, userId: ticket.userId, calendarId: ticket.calendarId, provider: ticket.provider,
      name: ticket.name, externalCalendarId: result.externalCalendarId, accountEmail: result.accountEmail, status: 'ACTIVE', syncCursor: null, lastSyncedAt: null,
      lastError: null, failureCount: 0, claimId: null, leaseExpiresAt: null, version: 1, createdAt: now, updatedAt: now };
    this.state.calendarSyncConnections.push(row);
    this.state.calendarSyncCredentials.push({ id: this.support.id(), workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider, credentialRef: result.credentialRef, createdAt: now, revokedAt: null });
    this.support.audit(actor, row.workspaceId, 'CALENDAR_SYNC.CONNECTED', 'CALENDAR_SYNC_CONNECTION', row.id, null, { provider: row.provider, calendarId: row.calendarId, accountEmail: row.accountEmail });
    this.support.event({ workspaceId: row.workspaceId, type: 'CALENDAR_SYNC_CONNECTED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: row.id, actorUserId: actor.user.id, changes: { provider: row.provider } });
    return this.view(row);
  }
  disconnect(actor: ActorContext, id: string, body: Body) {
    body.only([]);
    const row = this.connection(actor, id, 'calendar_sync.connect');
    if (row.status === 'DISCONNECTED') return this.view(row);
    row.status = 'DISCONNECTED'; row.claimId = null; row.leaseExpiresAt = null; this.support.touch(row);
    for (const credential of this.state.calendarSyncCredentials.filter(item => item.connectionId === row.id && !item.revokedAt)) credential.revokedAt = this.support.now();
    // Local Events and mappings remain as history; the broker revokes provider tokens from the outbox event.
    this.support.audit(actor, row.workspaceId, 'CALENDAR_SYNC.DISCONNECTED', 'CALENDAR_SYNC_CONNECTION', row.id, { status: 'ACTIVE' }, { status: 'DISCONNECTED' });
    this.support.event({ workspaceId: row.workspaceId, type: 'CALENDAR_SYNC_DISCONNECTED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: row.id, actorUserId: actor.user.id, changes: { provider: row.provider } });
    return this.view(row);
  }

  // ---- sync (staged) --------------------------------------------------------------------------------------------------

  private localEvents(connection: CalendarSyncConnection) {
    return this.state.calendarEvents.filter(row => row.workspaceId === connection.workspaceId && row.calendarId === connection.calendarId && !row.isDeleted && !row.recurrenceParentEventId);
  }
  private outbound(event: CalendarEvent, connection: CalendarSyncConnection): OutboundCalendarEvent {
    const rule = event.recurrenceRuleId ? this.state.calendarRecurrenceRules.find(row => row.id === event.recurrenceRuleId && !row.isDeleted) : undefined;
    return { localEventId: event.id, localVersion: event.version, title: event.title, description: event.description, location: event.location,
      status: event.status === 'CANCELLED' ? 'CANCELLED' : event.status === 'TENTATIVE' ? 'TENTATIVE' : 'CONFIRMED', isAllDay: event.isAllDay,
      startAt: event.startAt?.toISOString() ?? null, endAt: event.endAt?.toISOString() ?? null, startDate: event.startDate, endDate: event.endDate,
      sourceTimezone: event.sourceTimezone, rrule: rule?.rruleText ?? null, origin: { connectionId: connection.id, localVersion: event.version } };
  }
  /** Phase 1: claim the lease and snapshot local changes to push. */
  prepareSync(actor: ActorContext, id: string, body: Body): SyncTicket {
    body.only([]);
    const connection = this.connection(actor, id, 'calendar_sync.run');
    if (connection.provider === 'ICS') throw new AppError('CALENDAR_SYNC_MAPPING_INVALID', 'ICS connections sync by re-importing their content.', 409);
    if (connection.status === 'DISCONNECTED') throw new AppError('CALENDAR_SYNC_CONNECTION_NOT_FOUND', 'Calendar sync connection was not found.', 404);
    if (connection.status === 'AUTH_REQUIRED') throw new AppError('CALENDAR_SYNC_AUTH_REQUIRED', 'Reconnect this calendar before syncing.', 409);
    const now = this.support.now();
    if (connection.leaseExpiresAt && connection.leaseExpiresAt > now) throw new AppError('CALENDAR_SYNC_IN_PROGRESS', 'A sync for this connection is already running.', 409);
    const credential = this.state.calendarSyncCredentials.find(row => row.connectionId === connection.id && !row.revokedAt);
    if (!credential) throw new AppError('CALENDAR_SYNC_AUTH_REQUIRED', 'Reconnect this calendar before syncing.', 409);
    this.ownerActor(connection);
    this.targetCalendar(actor, connection.calendarId);
    const token = randomUUID();
    connection.claimId = token; connection.leaseExpiresAt = new Date(now.getTime() + LEASE_MS); this.support.touch(connection);
    const mappings = this.state.calendarSyncMappings.filter(row => row.connectionId === connection.id);
    const conflicted = new Set(this.state.calendarSyncConflicts.filter(row => row.connectionId === connection.id && row.status === 'OPEN').map(row => row.mappingId));
    const outbound: SyncTicket['outbound'] = [];
    for (const event of this.localEvents(connection)) {
      if (!this.events.canRead(actor, event)) continue;
      const mapping = mappings.find(row => row.localEventId === event.id);
      if (mapping && (mapping.localVersionAtLastSync === event.version || conflicted.has(mapping.id))) continue;
      if (!mapping && event.status === 'CANCELLED') continue;
      outbound.push({ mappingId: mapping?.id ?? null, externalEventId: mapping?.externalEventId ?? null, event: this.outbound(event, connection) });
    }
    return { connectionId: connection.id, workspaceId: connection.workspaceId, token, provider: connection.provider, credentialRef: credential.credentialRef,
      externalCalendarId: connection.externalCalendarId, cursor: connection.syncCursor, known: Object.fromEntries(mappings.map(row => [row.externalEventId, row.externalVersion])), outbound };
  }
  /** Phase 2 (outside state units): pull first, then push local changes that do not collide with pulled changes. */
  async exchangeChanges(ticket: SyncTicket, signal?: AbortSignal): Promise<SyncOutcome> {
    const identity = { connectionId: ticket.connectionId, workspaceId: ticket.workspaceId, provider: ticket.provider, credentialRef: ticket.credentialRef, externalCalendarId: ticket.externalCalendarId };
    const pulled = await this.provider.pull({ ...identity, cursor: ticket.cursor }, signal);
    const changed = new Set(pulled.events.filter(event => event.externalEventId in ticket.known && ticket.known[event.externalEventId] !== event.etag).map(event => event.externalEventId));
    const pushed: SyncOutcome['pushed'] = [];
    for (const item of ticket.outbound) {
      if (item.externalEventId && changed.has(item.externalEventId)) continue;
      // Idempotent per local version: a retried run re-sends the same key and the provider returns the same event.
      const result = await this.provider.push({ ...identity, externalEventId: item.externalEventId, event: item.event,
        idempotencyKey: `calendar-sync-push:${ticket.connectionId}:${item.event.localEventId}:${item.event.localVersion}` }, signal);
      pushed.push({ localEventId: item.event.localEventId, localVersion: item.event.localVersion, mappingId: item.mappingId, ...result });
    }
    return { pulled: pulled.events, nextCursor: pulled.nextCursor, pushed };
  }
  private live(ticket: SyncTicket) {
    const connection = this.state.calendarSyncConnections.find(row => row.id === ticket.connectionId && row.workspaceId === ticket.workspaceId);
    if (!connection || connection.claimId !== ticket.token || !connection.leaseExpiresAt || connection.leaseExpiresAt <= this.support.now())
      throw new AppError('CALENDAR_SYNC_IN_PROGRESS', 'The sync lease expired; run the sync again.', 409);
    return connection;
  }
  /** Phase 3: apply under the lease. Local state is re-read, so concurrent local edits become conflicts, not overwrites. */
  applySync(ticket: SyncTicket, outcome: SyncOutcome) {
    const connection = this.live(ticket), owner = this.ownerActor(connection), now = this.support.now();
    this.support.require(owner, 'calendar_sync.run');
    this.targetCalendar(owner, connection.calendarId);
    for (const item of ticket.outbound) {
      const event = this.state.calendarEvents.find(row => row.id === item.event.localEventId);
      if (!event || !this.events.canRead(owner, event)) throw forbidden('Event access changed during synchronization.');
    }
    const counts = { created: 0, updated: 0, pushed: 0, skipped: 0, conflicts: 0, errors: 0 };
    for (const item of outcome.pushed) {
      const event = this.state.calendarEvents.find(row => row.id === item.localEventId && row.workspaceId === connection.workspaceId);
      let mapping = item.mappingId ? this.state.calendarSyncMappings.find(row => row.id === item.mappingId) :
        this.state.calendarSyncMappings.find(row => row.connectionId === connection.id && row.localEventId === item.localEventId);
      if (!mapping) mapping = this.createMapping(connection, item.localEventId, item.externalEventId, item.etag, event?.version === item.localVersion ? item.localVersion : -1, 'OUTBOUND');
      else {
        mapping.externalEventId = item.externalEventId; mapping.externalVersion = item.etag; mapping.lastDirection = 'OUTBOUND'; mapping.lastSyncedAt = now;
        // A local edit made while pushing stays pending for the next run.
        if (event?.version === item.localVersion) mapping.localVersionAtLastSync = item.localVersion;
        this.support.touch(mapping);
      }
      counts.pushed++;
    }
    for (const external of outcome.pulled) this.applyInbound(owner, connection, connection.externalCalendarId, external, counts);
    connection.syncCursor = outcome.nextCursor; connection.lastSyncedAt = now; connection.lastError = null; connection.failureCount = 0;
    connection.claimId = null; connection.leaseExpiresAt = null; this.support.touch(connection);
    this.support.event({ workspaceId: connection.workspaceId, type: 'CALENDAR_SYNC_COMPLETED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: connection.id, actorUserId: owner.user.id, changes: counts,
      audienceUserIds: [connection.userId] });
    return { ...this.view(connection), result: counts };
  }
  /** Commits a provider failure; revoked authorization moves the connection to AUTH_REQUIRED. */
  failSync(ticket: SyncTicket, code: string) {
    const connection = this.state.calendarSyncConnections.find(row => row.id === ticket.connectionId && row.workspaceId === ticket.workspaceId);
    if (!connection || connection.claimId !== ticket.token) return;
    connection.claimId = null; connection.leaseExpiresAt = null; connection.lastError = code; connection.failureCount++;
    if (code === 'CALENDAR_SYNC_AUTH_REQUIRED') {
      connection.status = 'AUTH_REQUIRED';
      this.support.audit(null, connection.workspaceId, 'CALENDAR_SYNC.AUTH_REQUIRED', 'CALENDAR_SYNC_CONNECTION', connection.id, { status: 'ACTIVE' }, { status: 'AUTH_REQUIRED' });
    }
    this.support.touch(connection);
    this.support.event({ workspaceId: connection.workspaceId, type: 'CALENDAR_SYNC_FAILED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: connection.id, actorUserId: null,
      changes: { errorCode: code, failureCount: connection.failureCount }, audienceUserIds: [connection.userId] });
  }
  /** In-process orchestration of the three phases (service callers and tests); HTTP commits each phase separately. */
  async sync(actor: ActorContext, id: string, body: Body) {
    const ticket = this.prepareSync(actor, id, body);
    let outcome: SyncOutcome;
    try { outcome = await this.exchangeChanges(ticket); }
    catch (error) {
      const code = isAppError(error) ? error.code : 'CALENDAR_SYNC_PROVIDER_ERROR';
      this.failSync(ticket, code);
      throw code === 'CALENDAR_SYNC_AUTH_REQUIRED' ? new AppError(code, 'The calendar provider rejected the stored authorization. Reconnect it.', 409)
        : new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'The calendar provider is unavailable. Retry later.', 502);
    }
    try { return this.applySync(ticket, outcome); }
    catch (error) { this.failSync(ticket, isAppError(error) ? error.code : 'CALENDAR_SYNC_PROVIDER_ERROR'); throw error; }
  }

  // ---- inbound application --------------------------------------------------------------------------------------------

  private createMapping(connection: CalendarSyncConnection, localEventId: string, externalEventId: string, externalVersion: string | null, localVersion: number, direction: CalendarSyncMapping['lastDirection'], externalCalendarId = connection.externalCalendarId) {
    const now = this.support.now();
    const mapping: CalendarSyncMapping = { id: this.support.id(), workspaceId: connection.workspaceId, connectionId: connection.id, localEventId, externalCalendarId, externalEventId,
      externalVersion, localVersionAtLastSync: localVersion, lastDirection: direction, lastSyncedAt: now, version: 1, createdAt: now, updatedAt: now };
    this.state.calendarSyncMappings.push(mapping);
    return mapping;
  }
  private fields(external: ExternalCalendarEvent, fallbackTimezone: string) {
    return external.isAllDay ? { isAllDay: true, startDate: external.startDate, endDate: external.endDate }
      : { isAllDay: false, startAt: external.startAt, endAt: external.endAt, sourceTimezone: external.sourceTimezone ?? fallbackTimezone };
  }
  private snapshot(event: CalendarEvent) {
    return { title: event.title, description: event.description, location: event.location, status: event.status, isAllDay: event.isAllDay, startAt: event.startAt, endAt: event.endAt,
      startDate: event.startDate, endDate: event.endDate, sourceTimezone: event.sourceTimezone, version: event.version };
  }
  private applyInbound(owner: ActorContext, connection: CalendarSyncConnection, externalCalendarId: string, external: ExternalCalendarEvent, counts: Record<string, number>) {
    const mapping = this.state.calendarSyncMappings.find(row => row.connectionId === connection.id && row.externalCalendarId === externalCalendarId && row.externalEventId === external.externalEventId);
    // Echo suppression: our own write (same etag) or an unchanged event is never re-applied.
    if (mapping && mapping.externalVersion === external.etag) { counts.skipped++; return; }
    if (mapping && external.origin?.connectionId === connection.id && external.origin.localVersion === mapping.localVersionAtLastSync) {
      mapping.externalVersion = external.etag; this.support.touch(mapping); counts.skipped++; return;
    }
    const calendar = this.state.calendars.find(row => row.id === connection.calendarId)!;
    if (!mapping) {
      if (external.status === 'CANCELLED') { counts.skipped++; return; }
      const created = this.events.create(owner, new Body({ calendarId: connection.calendarId, title: external.title, description: external.description, location: external.location,
        status: external.status, ...this.fields(external, calendar.timezone) })) as { id: string; version: number };
      this.createMapping(connection, created.id, external.externalEventId, external.etag, created.version, 'INBOUND', externalCalendarId);
      counts.created++; return created.id;
    }
    const local = this.state.calendarEvents.find(row => row.id === mapping.localEventId && row.workspaceId === connection.workspaceId);
    if (!local || local.isDeleted) { mapping.externalVersion = external.etag; this.support.touch(mapping); counts.skipped++; return; }
    if (!this.events.canRead(owner, local)) throw forbidden('The mapped Event is no longer accessible.');
    const open = this.state.calendarSyncConflicts.find(row => row.mappingId === mapping.id && row.status === 'OPEN');
    if (local.version !== mapping.localVersionAtLastSync || open) {
      // Both sides changed since the last common sync point: keep both and ask a person.
      if (open) { open.externalSnapshotJson = { ...external }; open.externalVersion = external.etag; open.localSnapshotJson = this.snapshot(local); open.localVersion = local.version; this.support.touch(open); }
      else {
        const now = this.support.now(), conflict: CalendarSyncConflict = { id: this.support.id(), workspaceId: connection.workspaceId, connectionId: connection.id, mappingId: mapping.id,
          localEventId: local.id, localSnapshotJson: this.snapshot(local), externalSnapshotJson: { ...external }, externalVersion: external.etag, localVersion: local.version,
          status: 'OPEN', resolution: null, resolvedByUserId: null, resolvedAt: null, version: 1, createdAt: now, updatedAt: now };
        this.state.calendarSyncConflicts.push(conflict);
        this.support.event({ workspaceId: connection.workspaceId, type: 'CALENDAR_SYNC_CONFLICT', entityType: 'CALENDAR_SYNC_CONFLICT', entityId: conflict.id, actorUserId: null,
          changes: { connectionId: connection.id, localEventId: local.id }, audienceUserIds: [connection.userId] });
      }
      counts.conflicts++; return;
    }
    this.applyExternal(owner, local, external, calendar.timezone);
    mapping.externalVersion = external.etag; mapping.localVersionAtLastSync = local.version; mapping.lastDirection = 'INBOUND'; mapping.lastSyncedAt = this.support.now();
    this.support.touch(mapping);
    counts.updated++;
    return local.id;
  }
  private applyExternal(owner: ActorContext, local: CalendarEvent, external: Pick<ExternalCalendarEvent, 'title' | 'description' | 'location' | 'status' | 'isAllDay' | 'startAt' | 'endAt' | 'startDate' | 'endDate' | 'sourceTimezone'>, fallbackTimezone: string) {
    if (external.status === 'CANCELLED') { if (local.status !== 'CANCELLED') this.events.cancel(owner, local.id, new Body({ version: local.version })); return; }
    if (local.status === 'CANCELLED') this.events.cancel(owner, local.id, new Body({ version: local.version }), true);
    this.events.update(owner, local.id, new Body({ title: external.title, description: external.description, location: external.location, status: external.status,
      ...this.fields(external as ExternalCalendarEvent, fallbackTimezone), version: local.version }));
  }

  // ---- conflicts ------------------------------------------------------------------------------------------------------

  private conflict(actor: ActorContext, id: string, permission = 'calendar_sync.read') {
    this.support.require(actor, permission);
    const row = isUuid(id) ? this.state.calendarSyncConflicts.find(item => item.id === id.toLowerCase() && item.workspaceId === actor.workspaceId) : undefined;
    const connection = row && this.state.calendarSyncConnections.find(item => item.id === row.connectionId && (item.userId === actor.user.id || actor.role.isOwnerRole && permission === 'calendar_sync.read'));
    if (!row || !connection) throw notFoundError('CALENDAR_SYNC_CONFLICT_NOT_FOUND', 'Calendar sync conflict');
    const local = this.state.calendarEvents.find(event => event.id === row.localEventId);
    if (!local || !this.events.canRead(actor, local)) throw notFoundError('CALENDAR_SYNC_CONFLICT_NOT_FOUND', 'Calendar sync conflict');
    return { row, connection };
  }
  conflicts(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'calendar_sync.read');
    const own = new Set(this.state.calendarSyncConnections.filter(row => row.workspaceId === actor.workspaceId && (row.userId === actor.user.id || actor.role.isOwnerRole)).map(row => row.id));
    const rows = this.state.calendarSyncConflicts.filter(row => own.has(row.connectionId) &&
      this.state.calendarEvents.some(event => event.id === row.localEventId && this.events.canRead(actor, event))).map(row => ({ ...row }));
    return pageOf(rows, query, { searchable: [], filterable: ['status', 'connectionId', 'localEventId'], sortable: ['createdAt', 'updatedAt'], defaultSort: 'createdAt', defaultOrder: 'desc' });
  }
  getConflict(actor: ActorContext, id: string) { return { ...this.conflict(actor, id).row }; }
  /** Explicit resolution; until then the conflict stays OPEN and neither side overwrites the other. */
  resolve(actor: ActorContext, id: string, body: Body) {
    body.only(['resolution', 'merged', 'version']);
    const { row, connection } = this.conflict(actor, id, 'calendar_sync.resolve');
    if (row.status === 'RESOLVED') throw new AppError('CALENDAR_SYNC_CONFLICT', 'This conflict is already resolved.', 409);
    this.support.expectVersion(row, body.raw.version, false);
    const resolution = body.enumOf('resolution', ['LOCAL', 'EXTERNAL', 'MERGED', 'IGNORED'] as const, { required: true });
    const mapping = this.state.calendarSyncMappings.find(item => item.id === row.mappingId)!;
    const local = this.state.calendarEvents.find(item => item.id === row.localEventId && item.workspaceId === connection.workspaceId && !item.isDeleted);
    if (!local) throw new AppError('CALENDAR_SYNC_MAPPING_INVALID', 'The local Event no longer exists.', 409);
    if (local.version !== row.localVersion) throw new AppError('RESOURCE_VERSION_CONFLICT', 'The Event changed after this conflict was captured. Sync again before resolving.', 409);
    const owner = this.ownerActor(connection), fallback = this.state.calendars.find(item => item.id === connection.calendarId)?.timezone ?? 'UTC';
    const external = row.externalSnapshotJson as unknown as ExternalCalendarEvent;
    if (resolution === 'EXTERNAL') this.applyExternal(owner, local, external, fallback);
    if (resolution === 'MERGED') {
      const merged = body.object('merged', { required: true })!;
      new Body(merged).only(['title', 'description', 'location', 'status', 'isAllDay', 'startAt', 'endAt', 'startDate', 'endDate', 'sourceTimezone']);
      this.events.update(owner, local.id, new Body({ ...merged, version: local.version }));
    }
    else if (body.has('merged')) throw validationError('merged', 'merged applies to MERGED resolutions only.');
    // LOCAL and MERGED leave the local version ahead so the next sync pushes it; EXTERNAL and IGNORED accept the current pair.
    mapping.externalVersion = row.externalVersion;
    if (resolution === 'EXTERNAL' || resolution === 'IGNORED') mapping.localVersionAtLastSync = local.version;
    else if (mapping.localVersionAtLastSync === local.version) mapping.localVersionAtLastSync = -1;
    mapping.lastSyncedAt = this.support.now(); this.support.touch(mapping);
    row.status = 'RESOLVED'; row.resolution = resolution; row.resolvedByUserId = actor.user.id; row.resolvedAt = this.support.now(); this.support.touch(row);
    this.support.audit(actor, row.workspaceId, 'CALENDAR_SYNC.CONFLICT_RESOLVED', 'CALENDAR_SYNC_CONFLICT', row.id, { status: 'OPEN' }, { resolution, localEventId: local.id });
    this.support.event({ workspaceId: row.workspaceId, type: 'CALENDAR_SYNC_CONFLICT_RESOLVED', entityType: 'CALENDAR_SYNC_CONFLICT', entityId: row.id, actorUserId: actor.user.id, changes: { resolution } });
    return { ...row };
  }

  // ---- ICS ------------------------------------------------------------------------------------------------------------

  /** Re-importing the same source is idempotent: UIDs map to stable local Events; locally edited Events conflict instead of being overwritten. */
  importIcs(actor: ActorContext, body: Body) {
    this.support.require(actor, 'calendar_sync.connect');
    body.only(['calendarId', 'icsContent', 'sourceName']);
    const calendar = this.targetCalendar(actor, body.uuid('calendarId', { required: true }));
    const content = body.str('icsContent', { required: true, trim: false, max: 1_048_576 });
    const sourceName = (body.str('sourceName', { max: 100 }) ?? 'import').toLowerCase();
    if (!/^[a-z0-9._-]{1,100}$/.test(sourceName)) throw validationError('sourceName', 'sourceName may contain letters, digits and . _ - only.');
    const parsed = parseIcs(content, calendar.timezone);
    const externalCalendarId = `ics:${sourceName}`, now = this.support.now();
    let connection = this.state.calendarSyncConnections.find(row => row.workspaceId === actor.workspaceId && row.userId === actor.user.id && row.calendarId === calendar.id &&
      row.provider === 'ICS' && row.externalCalendarId === externalCalendarId && row.status !== 'DISCONNECTED');
    if (!connection) {
      connection = { id: this.support.id(), workspaceId: actor.workspaceId, userId: actor.user.id, calendarId: calendar.id, provider: 'ICS', name: `ICS ${sourceName}`,
        externalCalendarId, accountEmail: null, status: 'ACTIVE', syncCursor: null, lastSyncedAt: null, lastError: null, failureCount: 0, claimId: null, leaseExpiresAt: null,
        version: 1, createdAt: now, updatedAt: now };
      this.state.calendarSyncConnections.push(connection);
      this.support.audit(actor, actor.workspaceId, 'CALENDAR_SYNC.CONNECTED', 'CALENDAR_SYNC_CONNECTION', connection.id, null, { provider: 'ICS', calendarId: calendar.id, sourceName });
      this.support.event({ workspaceId: actor.workspaceId, type: 'CALENDAR_SYNC_CONNECTED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: connection.id, actorUserId: actor.user.id, changes: { provider: 'ICS' } });
    }
    const counts = { created: 0, updated: 0, pushed: 0, skipped: 0, conflicts: 0, errors: 0 }, warnings = [...parsed.warnings];
    for (const item of parsed.events) {
      const external = this.fromIcs(item);
      try {
        const createdId = this.applyInbound(actor, connection, externalCalendarId, external, counts);
        if (createdId && item.rrule) {
          // Recurrence is preserved when the rule fits the Calendar recurrence model; otherwise the first instance stays.
          try {
            const local = this.state.calendarEvents.find(row => row.id === createdId)!;
            const rule = this.state.calendarRecurrenceRules.find(row => row.id === local.recurrenceRuleId && !row.isDeleted);
            this.recurrence.update(actor, createdId, new Body({ rruleText: item.rrule, sourceTimezone: item.sourceTimezone, version: rule?.version ?? 0 }), true);
            const mapping = this.state.calendarSyncMappings.find(row => row.connectionId === connection!.id && row.localEventId === createdId)!;
            mapping.localVersionAtLastSync = local.version;
          }
          catch { warnings.push({ uid: item.uid, code: 'RRULE_UNSUPPORTED', message: 'The recurrence rule could not be imported; the first instance was kept.' }); }
        }
      } catch (error) {
        if (!isAppError(error)) throw error;
        counts.errors++; warnings.push({ uid: item.uid, code: error.code, message: error.message });
      }
    }
    connection.lastSyncedAt = now; this.support.touch(connection);
    this.support.event({ workspaceId: actor.workspaceId, type: 'CALENDAR_SYNC_COMPLETED', entityType: 'CALENDAR_SYNC_CONNECTION', entityId: connection.id, actorUserId: actor.user.id, changes: counts });
    return { connection: this.view(connection), result: counts, warnings };
  }
  private fromIcs(item: IcsEvent): ExternalCalendarEvent {
    return { externalEventId: item.uid, etag: item.etag, status: item.status, title: item.title, description: item.description, location: item.location, isAllDay: item.isAllDay,
      startAt: item.startAt?.toISOString() ?? null, endAt: item.endAt?.toISOString() ?? null, startDate: item.startDate, endDate: item.endDate, sourceTimezone: item.sourceTimezone, origin: null };
  }
  /** Exports Events the caller can read in one Calendar. */
  exportIcs(actor: ActorContext, query: URLSearchParams) {
    this.support.require(actor, 'calendar_sync.read');
    new Body(Object.fromEntries(query)).only(['calendarId', 'from', 'to']);
    const calendarId = query.get('calendarId');
    if (!isUuid(calendarId)) throw validationError('calendarId', 'calendarId must be a UUID.');
    const calendar = this.policy.calendar(actor, calendarId);
    const parse = (key: string, fallback: Date) => {
      const raw = query.get(key);
      if (!raw) return fallback;
      const value = new Date(raw);
      if (Number.isNaN(value.getTime())) throw new AppError('QUERY_INVALID', `${key} must be an ISO-8601 instant.`, 400);
      return value;
    };
    const now = this.support.now(), from = parse('from', new Date(now.getTime() - 30 * 86_400_000)), to = parse('to', new Date(now.getTime() + 365 * 86_400_000));
    if (to <= from || to.getTime() - from.getTime() > 3 * 366 * 86_400_000) throw new AppError('QUERY_INVALID', 'The export window must be positive and at most three years.', 400);
    const rows = this.state.calendarEvents.filter(row => row.calendarId === calendar.id && row.workspaceId === actor.workspaceId && !row.isDeleted && !row.recurrenceParentEventId)
      .filter(row => {
        const start = row.isAllDay ? new Date(`${row.startDate}T00:00:00Z`) : row.startAt!, end = row.isAllDay ? new Date(`${row.endDate}T00:00:00Z`) : row.endAt!;
        return (row.recurrenceRuleId || end > from && start < to) && this.events.canRead(actor, row);
      }).slice(0, 5000);
    const content = serializeIcs(calendar.name, rows.map(row => ({ ...row, rrule: row.recurrenceRuleId ? this.state.calendarRecurrenceRules.find(rule => rule.id === row.recurrenceRuleId && !rule.isDeleted)?.rruleText ?? null : null,
      sequence: Math.max(0, row.version - 1) })));
    return { filename: `${calendar.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'calendar'}.ics`, content, eventCount: rows.length };
  }
}
