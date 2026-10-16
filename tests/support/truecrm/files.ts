import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { LocalObjectStorage } from '../../../src/server/collab/files/object-storage';

/**
 * Safe Files seeder: writes immutable bytes to the local object store and registers a Drive file whose
 * current version carries the given scan state (Files remains the binary/version source of truth).
 */
export async function seedDriveFile(db: PrismaClient, workspaceId: string, userId: string, bytes: Buffer, name: string, scanStatus: 'CLEAN' | 'PENDING' | 'INFECTED' = 'CLEAN') {
  const id = randomUUID(), versionId = randomUUID(), objectKey = `contract/${workspaceId}/${versionId}`, now = new Date();
  await new LocalObjectStorage().putImmutable(objectKey, bytes);
  const extension = name.includes('.') ? name.split('.').pop()! : '';
  const mimeType = extension === 'csv' ? 'text/csv' : extension === 'png' ? 'image/png' : 'application/octet-stream';
  await db.driveFile.create({ data: { id, workspaceId, storageId: randomUUID(), folderId: randomUUID(), name, extension, mimeType, currentVersionId: versionId, status: scanStatus === 'CLEAN' ? 'ACTIVE' : 'PROCESSING', sizeBytesCurrent: bytes.length, createdAt: now, updatedAt: now } });
  await db.driveFileVersion.create({ data: { id: versionId, workspaceId, fileId: id, versionNumber: 1, objectKey, sizeBytes: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), mimeType, createdByUserId: userId, createdAt: now, scanStatus, processedAt: scanStatus === 'CLEAN' ? now : null } });
  return { id, versionId };
}
