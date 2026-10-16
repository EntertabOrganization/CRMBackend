import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { LocalObjectStorage } from '../collab/files/object-storage';

/**
 * Narrow Files contract for the business suite. Binary/version truth stays in Files; callers get only
 * scan-cleared, processed, workspace-owned content and the attached resource ACL is checked by the caller.
 * File ACL ∩ business ACL: an explicit NONE assignment for the actor denies even if the business record allows.
 */
export async function cleanFile(tx: Tx, actor: Principal, fileId: string, permission = 'file.read') {
  requirePermission(actor, permission);
  const file = await tx.driveFile.findFirst({ where: { workspaceId: actor.workspaceId, id: fileId } });
  if (!file || file.trashedAt) throw new AppError('NOT_FOUND', 'File was not found.', 404);
  const version = file.currentVersionId ? await tx.driveFileVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: file.currentVersionId } }) : null;
  if (file.status !== 'ACTIVE' || version?.scanStatus !== 'CLEAN' || !version.processedAt) throw new AppError('FILE_QUARANTINED', 'Only scan-cleared processed files can be used.', 409);
  const denied = await tx.filePermissionAssignment.findFirst({ where: { workspaceId: actor.workspaceId, resourceType: 'FILE', resourceId: fileId, subjectType: 'USER', subjectId: actor.userId, permissionLevel: 'NONE' } });
  if (denied) throw new AppError('NOT_FOUND', 'File was not found.', 404);
  return { file, version };
}

const storage = new LocalObjectStorage();
export async function readCleanFile(tx: Tx, actor: Principal, fileId: string, maxBytes: number) {
  const { file, version } = await cleanFile(tx, actor, fileId);
  if (version!.sizeBytes > maxBytes) throw new AppError('VALIDATION_FAILED', 'File exceeds the import size quota.', 400, { fields: [{ field: 'fileId', reason: 'TOO_LARGE' }] });
  return { file, version: version!, bytes: await storage.read(version!.objectKey) };
}
