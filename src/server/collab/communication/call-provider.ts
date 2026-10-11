import { createHmac } from 'node:crypto';
import { AppError } from '../../errors';

export type CallRoomRequest = { callId: string; workspaceId: string; callType: 'AUDIO' | 'VIDEO' };
export type CallRoomAccess = { joinUrl: string; token: string; expiresAt: Date };
/** Media transport belongs to the provider/SFU; TrueCRM owns call state and authorization. */
export interface CallMediaProvider {
  readonly name: string;
  createRoom(request: CallRoomRequest, signal?: AbortSignal): Promise<{ roomId: string }>;
  participantAccess(roomId: string, participantId: string, displayName: string, expiresAt: Date): CallRoomAccess;
}

const unavailable = () => new AppError('CALL_PROVIDER_ERROR', 'The call provider is unavailable.', 502);

/**
 * Authenticated media broker. CALL_PROVIDER_URL is a trusted HTTPS base URL (loopback HTTP is allowed for fixtures);
 * CALL_PROVIDER_TOKEN authenticates server calls and signs participant tokens. Room creation is idempotent per call.
 */
export class HttpCallProvider implements CallMediaProvider {
  readonly name = 'BROKER';
  constructor(private readonly base: string, private readonly secret: string, private readonly timeoutMs = 10_000) {}
  private url() {
    let url: URL;
    try { url = new URL(this.base); } catch { throw unavailable(); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || !this.secret || /[\r\n]/.test(this.secret))
      throw unavailable();
    return url;
  }
  async createRoom(request: CallRoomRequest, signal?: AbortSignal) {
    const url = this.url(), combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(new URL('rooms', url.href.endsWith('/') ? url : `${url.href}/`), { method: 'POST', redirect: 'manual', signal: combined,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', 'idempotency-key': `call-room:${request.callId}` },
        body: JSON.stringify(request) });
      const text = response.ok ? await response.text() : (await response.body?.cancel(), '');
      if (!response.ok || text.length > 4096) throw unavailable();
      const result = JSON.parse(text) as { roomId?: unknown; callId?: unknown };
      if (result.callId !== request.callId || typeof result.roomId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(result.roomId)) throw unavailable();
      return { roomId: result.roomId };
    } catch { throw unavailable(); }
  }
  participantAccess(roomId: string, participantId: string, displayName: string, expiresAt: Date) {
    const url = this.url();
    const payload = Buffer.from(JSON.stringify({ roomId, participantId, displayName, exp: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
    const token = `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
    return { joinUrl: `${url.href.replace(/\/$/, '')}/join/${encodeURIComponent(roomId)}`, token, expiresAt };
  }
}

/** Reads configuration per call so disabled providers fail closed and credentials rotate without restarts. */
export class EnvironmentCallProvider implements CallMediaProvider {
  readonly name = 'BROKER';
  private configured() { return new HttpCallProvider(process.env.CALL_PROVIDER_URL ?? '', process.env.CALL_PROVIDER_TOKEN ?? ''); }
  createRoom(request: CallRoomRequest, signal?: AbortSignal) { return this.configured().createRoom(request, signal); }
  participantAccess(roomId: string, participantId: string, displayName: string, expiresAt: Date) { return this.configured().participantAccess(roomId, participantId, displayName, expiresAt); }
}
