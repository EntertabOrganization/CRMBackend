import { AppError } from '../../errors';
import { isCalendarDate, isIanaTimezone } from '../support';
import type { ExternalCalendarEvent, OutboundCalendarEvent } from './sync-types';

export type ProviderIdentity = { connectionId: string; workspaceId: string; provider: 'GOOGLE' | 'MICROSOFT' };
/**
 * OAuth and provider APIs live behind an authenticated sync broker (integration credential store). TrueCRM keeps only
 * an opaque credentialRef; the broker binds every call to the connection identity and idempotency key.
 */
export interface CalendarSyncProvider {
  connect(identity: ProviderIdentity & { userId: string; authorizationCode: string; redirectUri: string; externalCalendarId: string | null }, signal?: AbortSignal):
    Promise<{ credentialRef: string; externalCalendarId: string; accountEmail: string | null }>;
  pull(identity: ProviderIdentity & { credentialRef: string; externalCalendarId: string; cursor: string | null }, signal?: AbortSignal):
    Promise<{ events: ExternalCalendarEvent[]; nextCursor: string }>;
  push(identity: ProviderIdentity & { credentialRef: string; externalCalendarId: string; externalEventId: string | null; event: OutboundCalendarEvent; idempotencyKey: string },
    signal?: AbortSignal): Promise<{ externalEventId: string; etag: string }>;
}

const providerError = () => new AppError('CALENDAR_SYNC_PROVIDER_ERROR', 'The calendar provider is unavailable.', 502);
const authRequired = () => new AppError('CALENDAR_SYNC_AUTH_REQUIRED', 'The calendar provider rejected the stored authorization.', 401);
const ID_RE = /^[A-Za-z0-9._:@=+/-]{1,500}$/;

/** Validates untrusted provider output before it can touch Calendar state. */
export function validateExternalEvent(value: unknown): ExternalCalendarEvent {
  const event = value as ExternalCalendarEvent;
  const text = (input: unknown, max: number, nullable = true) => input === null && nullable || typeof input === 'string' && input.length <= max;
  const instant = (input: unknown) => input === null || typeof input === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(input) && !Number.isNaN(Date.parse(input));
  const date = (input: unknown) => input === null || typeof input === 'string' && isCalendarDate(input);
  if (!event || typeof event !== 'object' || typeof event.externalEventId !== 'string' || !ID_RE.test(event.externalEventId) || typeof event.etag !== 'string' || !event.etag || event.etag.length > 500 ||
    !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(event.status) || !text(event.title, 500, false) || !text(event.description ?? null, 50_000) || !text(event.location ?? null, 2000) ||
    typeof event.isAllDay !== 'boolean' || !instant(event.startAt ?? null) || !instant(event.endAt ?? null) || !date(event.startDate ?? null) || !date(event.endDate ?? null) ||
    event.sourceTimezone != null && !isIanaTimezone(event.sourceTimezone)) throw providerError();
  if (event.status !== 'CANCELLED' && (event.isAllDay
    ? !event.startDate || !event.endDate || event.endDate <= event.startDate || event.startAt != null || event.endAt != null
    : !event.startAt || !event.endAt || Date.parse(event.endAt) <= Date.parse(event.startAt) || event.startDate != null || event.endDate != null)) throw providerError();
  return { externalEventId: event.externalEventId, etag: event.etag, status: event.status, title: event.title, description: event.description ?? null, location: event.location ?? null,
    isAllDay: event.isAllDay, startAt: event.startAt ?? null, endAt: event.endAt ?? null, startDate: event.startDate ?? null, endDate: event.endDate ?? null,
    sourceTimezone: event.sourceTimezone ?? null, origin: event.origin && typeof event.origin.connectionId === 'string' && Number.isInteger(event.origin.localVersion) ? event.origin : null };
}

export class HttpCalendarSyncProvider implements CalendarSyncProvider {
  constructor(private readonly base: string, private readonly token: string, private readonly timeoutMs = 15_000) {}
  private url(path: string) {
    let url: URL;
    try { url = new URL(this.base); } catch { throw providerError(); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || !this.token || /[\r\n]/.test(this.token)) throw providerError();
    return new URL(path, url.href.endsWith('/') ? url : `${url.href}/`);
  }
  private async call<T>(path: string, body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<T> {
    const target = this.url(path), combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', redirect: 'manual', signal: combined,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    } catch { throw providerError(); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw authRequired(); }
    if (!response.ok) { await response.body?.cancel(); throw providerError(); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel().catch(() => undefined); throw providerError(); }
        chunks.push(value);
      }
    } catch { throw providerError(); }
    finally { reader?.releaseLock(); }
    const text = Buffer.concat(chunks, size).toString('utf8');
    try { const parsed = JSON.parse(text) as T & { connectionId?: unknown }; if (parsed.connectionId !== body.connectionId) throw providerError(); return parsed; }
    catch { throw providerError(); }
  }
  async connect(identity: Parameters<CalendarSyncProvider['connect']>[0], signal?: AbortSignal) {
    const result = await this.call<{ credentialRef?: unknown; externalCalendarId?: unknown; accountEmail?: unknown }>('connect', identity, `calendar-sync-connect:${identity.connectionId}`, signal);
    if (typeof result.credentialRef !== 'string' || !ID_RE.test(result.credentialRef) || typeof result.externalCalendarId !== 'string' || !ID_RE.test(result.externalCalendarId)) throw providerError();
    return { credentialRef: result.credentialRef, externalCalendarId: result.externalCalendarId, accountEmail: typeof result.accountEmail === 'string' ? result.accountEmail.slice(0, 320) : null };
  }
  async pull(identity: Parameters<CalendarSyncProvider['pull']>[0], signal?: AbortSignal) {
    const result = await this.call<{ events?: unknown; nextCursor?: unknown }>('pull', identity, `calendar-sync-pull:${identity.connectionId}:${identity.cursor ?? 'initial'}`, signal);
    if (!Array.isArray(result.events) || result.events.length > 5000 || typeof result.nextCursor !== 'string' || result.nextCursor.length > 2000) throw providerError();
    return { events: result.events.map(validateExternalEvent), nextCursor: result.nextCursor };
  }
  async push(identity: Parameters<CalendarSyncProvider['push']>[0], signal?: AbortSignal) {
    const result = await this.call<{ externalEventId?: unknown; etag?: unknown }>('push', identity, identity.idempotencyKey, signal);
    if (typeof result.externalEventId !== 'string' || !ID_RE.test(result.externalEventId) || typeof result.etag !== 'string' || !result.etag || result.etag.length > 500) throw providerError();
    return { externalEventId: result.externalEventId, etag: result.etag };
  }
}

/** Reads configuration per call: an unconfigured broker fails closed and credentials rotate without restarts. */
export class EnvironmentCalendarSyncProvider implements CalendarSyncProvider {
  private configured() { return new HttpCalendarSyncProvider(process.env.CALENDAR_SYNC_BROKER_URL ?? '', process.env.CALENDAR_SYNC_BROKER_TOKEN ?? ''); }
  connect(identity: Parameters<CalendarSyncProvider['connect']>[0], signal?: AbortSignal) { return this.configured().connect(identity, signal); }
  pull(identity: Parameters<CalendarSyncProvider['pull']>[0], signal?: AbortSignal) { return this.configured().pull(identity, signal); }
  push(identity: Parameters<CalendarSyncProvider['push']>[0], signal?: AbortSignal) { return this.configured().push(identity, signal); }
}
