import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { assertProcessingResult, type FileContentProcessor, type ProcessingResult } from './object-storage';

/** Trusted scanner/preview service. Only deployment configuration chooses the endpoint; callers supply no URL. */
export class HttpContentProcessor implements FileContentProcessor {
  constructor(private readonly endpoint: string, private readonly token: string, private readonly timeoutMs = 15_000) {}
  assertConfigured() {
    let url: URL;
    try { url = new URL(this.endpoint); } catch { throw this.unavailable(); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash ||
      !this.token || /[\r\n]/.test(this.token) || this.token.length > 4096 || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw this.unavailable();
  }
  private unavailable() { return new AppError('FILE_PROCESSOR_UNAVAILABLE', 'The scanner and content processor are unavailable.', 503); }
  async process(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<ProcessingResult> {
    this.assertConfigured();
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'manual', signal: combined,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': mimeType, 'x-content-sha256': checksum, 'idempotency-key': `file-processing:${checksum}:${mimeType}` },
        body: new Uint8Array(bytes) });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        await response.body?.cancel(); throw this.unavailable();
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); throw this.unavailable(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      assertProcessingResult(result);
      if ((result as ProcessingResult & { checksum?: unknown }).checksum !== checksum) throw this.unavailable();
      return { scanStatus: result.scanStatus, processed: result.processed };
    } catch { throw this.unavailable(); }
  }
}

/** Read configuration per call so disabled providers fail closed and token rotation does not require cached clients. */
export class EnvironmentContentProcessor implements FileContentProcessor {
  private configured() { return new HttpContentProcessor(process.env.FILE_PROCESSOR_URL ?? '', process.env.FILE_PROCESSOR_TOKEN ?? ''); }
  assertConfigured() { this.configured().assertConfigured(); }
  process(bytes: Buffer, mimeType: string, signal?: AbortSignal) { return this.configured().process(bytes, mimeType, signal); }
}
