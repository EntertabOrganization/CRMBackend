import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';

export interface ObjectStorage {
  putImmutable(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove?(key: string): Promise<void>;
  purgeMultipart?(workspaceId: string, sessionId: string): Promise<void>;
}
export interface FileContentProcessor {
  assertConfigured?(): void;
  process(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<ProcessingResult>;
}
export type ProcessingResult = { scanStatus: 'CLEAN' | 'BLOCKED'; processed: boolean };
export function assertProcessingResult(value: unknown): asserts value is ProcessingResult {
  const result = value as ProcessingResult | null;
  if (!result || !['CLEAN', 'BLOCKED'].includes(result.scanStatus) || typeof result.processed !== 'boolean')
    throw new AppError('FILE_PROCESSOR_UNAVAILABLE', 'The content processor returned an invalid result.', 503);
}
export class UnconfiguredContentProcessor implements FileContentProcessor {
  assertConfigured(): never { throw new AppError('FILE_PROCESSOR_UNAVAILABLE', 'Configure a malware scanner and content processor before completing uploads.', 503); }
  async process(): Promise<never> { throw new AppError('FILE_PROCESSOR_UNAVAILABLE', 'Configure a malware scanner and content processor before completing uploads.', 503); }
}
/** Shared durable volume required when deploying multiple server processes. Keys never use caller filenames. */
export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root = path.resolve(process.env.FILE_OBJECT_ROOT ?? '.local-file-objects')) {}
  private filename(key: string) {
    if (!/^[a-f0-9-]{36}\/(?:uploads|objects)\/[A-Za-z0-9/_-]+$/.test(key) || key.split('/').some(part => part === '.' || part === '..')) throw new AppError('FILE_OBJECT_INVALID', 'Invalid object identity.', 409);
    const resolved = path.resolve(this.root, ...key.split('/'));
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new AppError('FILE_OBJECT_INVALID', 'Invalid object identity.', 409);
    return resolved;
  }
  async putImmutable(key: string, bytes: Buffer) {
    const filename = this.filename(key); await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // Publish only fully written bytes. Linking never replaces an existing immutable object.
      try { await link(temporary, filename); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(filename);
        if (existing.length !== bytes.length || createHash('sha256').update(existing).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) throw new AppError('UPLOAD_CHECKSUM_MISMATCH', 'Immutable object content differs.', 409);
      }
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  async read(key: string) { return readFile(this.filename(key)); }
  async remove(key: string) {
    try { await unlink(this.filename(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async purgeMultipart(workspaceId: string, sessionId: string) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (!uuid.test(workspaceId) || !uuid.test(sessionId)) throw new AppError('FILE_OBJECT_INVALID', 'Invalid multipart identity.', 409);
    const target = this.filename(`${workspaceId}/uploads/${sessionId}/parts`);
    // filename resolves and verifies that the exact protocol directory remains inside the configured private root.
    await rm(target, { recursive: true, force: true });
  }
}
