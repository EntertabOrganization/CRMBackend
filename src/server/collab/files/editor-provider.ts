import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import type { EditProviderName } from './editing-types';

export type EditorIdentity = { id: string; workspaceId: string; fileId: string; userId: string; baseVersionId: string; provider: EditProviderName };
export type EditorSource = EditorIdentity & { mimeType: string; name: string; checksum: string; bytes: Buffer; expiresAt: Date };
export type EditorResult = { bytes: Buffer; mimeType: string; checksum: string };
/** Providers must honor the caller-supplied identity/idempotency key and return the exact bound source identity. */
export interface EditingProvider {
  assertConfigured(provider: EditProviderName): void;
  supports(provider: EditProviderName, mimeType: string): boolean;
  open(source: EditorSource, signal?: AbortSignal): Promise<{ providerSessionId: string; editorUrl: string | null }>;
  save(identity: EditorIdentity, mimeType: string, input: { dataBase64?: string; saveId?: string }, signal?: AbortSignal): Promise<EditorResult>;
  close(identity: EditorIdentity, signal?: AbortSignal): Promise<void>;
}
const MAX_BYTES = 100 * 1024 * 1024;
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/html'];
const DOCUMENT_TYPES = [...TEXT_TYPES, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.text'];

function content(data: unknown, mimeType: string): EditorResult {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned invalid or oversized content.', 502);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== data) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned invalid content.', 502);
  if (TEXT_TYPES.includes(mimeType)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError('EDIT_PROVIDER_ERROR', 'Text content must use valid UTF-8.', 502); }
  }
  return { bytes, mimeType, checksum: createHash('sha256').update(bytes).digest('hex') };
}

/** Local text editing plus a configurable, authenticated broker for vendor-specific editor integrations. */
export class EnvironmentEditingProvider implements EditingProvider {
  private endpoint() {
    const raw = process.env.FILE_EDITOR_URL, token = process.env.FILE_EDITOR_TOKEN;
    if (!raw || !token) throw new AppError('EDIT_PROVIDER_ERROR', 'Configure the editing provider before opening vendor editor sessions.', 503);
    let url: URL;
    try { url = new URL(raw); } catch { throw new AppError('EDIT_PROVIDER_ERROR', 'The editing provider configuration is invalid.', 503); }
    if (token.length > 4096 || /[\r\n]/.test(token) || url.username || url.password || url.search || url.hash || url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      throw new AppError('EDIT_PROVIDER_ERROR', 'The editing provider configuration is invalid.', 503);
    return { url, token };
  }
  assertConfigured(provider: EditProviderName) { if (provider !== 'INTERNAL_DOCS') this.endpoint(); }
  supports(provider: EditProviderName, mimeType: string) { return (provider === 'INTERNAL_DOCS' ? TEXT_TYPES : DOCUMENT_TYPES).includes(mimeType); }
  private async request(operation: string, identity: EditorIdentity, extra: Record<string, unknown>, signal?: AbortSignal) {
    const { url, token } = this.endpoint();
    const target = new URL(`${url.pathname.replace(/\/$/, '')}/sessions/${operation}`, url.origin);
    try {
      const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          'Idempotency-Key': `${identity.id}:${operation}:${createHash('sha256').update(String(extra.saveId ?? '')).digest('hex')}` },
        body: JSON.stringify({ ...identity, ...extra }) });
      if (!response.ok || !response.body) throw new Error('Unavailable');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > Math.ceil(MAX_BYTES / 3) * 4 + 65536) { await reader.cancel(); throw new Error('Oversized'); }
          chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      for (const key of ['id', 'workspaceId', 'fileId', 'userId', 'baseVersionId', 'provider'] as const)
        if (value[key] !== identity[key]) throw new Error('Unbound response');
      return value;
    } catch { throw new AppError('EDIT_PROVIDER_ERROR', 'The editor request failed or returned an unbound result.', 502); }
  }
  async open(source: EditorSource, signal?: AbortSignal) {
    this.assertConfigured(source.provider);
    if (!this.supports(source.provider, source.mimeType)) throw new AppError('FILE_NOT_EDITABLE', 'The provider does not support this content type.', 409);
    if (source.bytes.length > MAX_BYTES || createHash('sha256').update(source.bytes).digest('hex') !== source.checksum)
      throw new AppError('EDIT_PROVIDER_ERROR', 'The source content checksum or size is invalid.', 502);
    if (source.provider === 'INTERNAL_DOCS') {
      const checked = content(source.bytes.toString('base64'), source.mimeType);
      if (checked.checksum !== source.checksum) throw new AppError('EDIT_PROVIDER_ERROR', 'The source content checksum is invalid.', 502);
      return { providerSessionId: source.id, editorUrl: null };
    }
    const { bytes, expiresAt, ...metadata } = source;
    const value = await this.request('open', metadata, { mimeType: source.mimeType, name: source.name, checksum: source.checksum,
      expiresAt: expiresAt.toISOString(), dataBase64: bytes.toString('base64') }, signal);
    if (value.providerSessionId !== source.id || typeof value.editorUrl !== 'string' || value.editorUrl.length > 8192)
      throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned an invalid session identity.', 502);
    let target: URL;
    try { target = new URL(value.editorUrl); } catch { throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned an invalid launch address.', 502); }
    if (target.protocol !== 'https:' || target.username || target.password) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned an invalid launch address.', 502);
    return { providerSessionId: source.id, editorUrl: target.toString() };
  }
  async save(identity: EditorIdentity, mimeType: string, input: { dataBase64?: string; saveId?: string }, signal?: AbortSignal) {
    if (identity.provider === 'INTERNAL_DOCS') return content(input.dataBase64, mimeType);
    if (!input.saveId || input.dataBase64 !== undefined) throw new AppError('EDIT_PROVIDER_ERROR', 'Supply a provider save receipt for this session.', 400);
    const value = await this.request('save', identity, { saveId: input.saveId }, signal);
    if (value.saveId !== input.saveId || value.mimeType !== mimeType) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor returned a mismatched save receipt.', 502);
    const result = content(value.dataBase64, mimeType);
    if (value.checksum !== result.checksum) throw new AppError('EDIT_PROVIDER_ERROR', 'The editor save checksum is invalid.', 502);
    return result;
  }
  async close(identity: EditorIdentity, signal?: AbortSignal) { if (identity.provider !== 'INTERNAL_DOCS') await this.request('close', identity, {}, signal); }
}
