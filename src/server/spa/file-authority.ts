import type { Tx } from '../process-platform/context';
import { resolvePrincipal } from '../process-platform/context';
import { AppError } from '../errors';
import { SpaPolicyService } from './policy-service';
import type { FileContentPurpose } from '../collab/files/content-authority';

/** Byte delivery rechecks SQL authority after provider I/O, independently of the shared request snapshot. */
export async function authorizeSpaFileBindings(tx: Tx, policies: SpaPolicyService, workspaceId: string, userId: string, objectKey: string, purpose: FileContentPurpose) {
  const versions = await tx.driveFileVersion.findMany({ where: { workspaceId, objectKey }, select: { fileId: true } });
  if (!versions.length) return;
  const fileIds = [...new Set(versions.map(v => v.fileId))];
  const bindings = await tx.fileAttachment.findMany({ where: { workspaceId, fileId: { in: fileIds }, entityType: 'SPA_ITEM' } });
  const candidates = await tx.spaItemValue.findMany({ where: { workspaceId,
    OR: [{ valueText: { in: fileIds } }, ...fileIds.map(id => ({ valueJson: { array_contains: [id] } }))] } });
  const fields = candidates.length ? await tx.spaFieldDefinition.findMany({ where: { workspaceId, fieldType: 'FILE',
    id: { in: [...new Set(candidates.map(v => v.fieldId))] } }, select: { id: true } }) : [];
  const fileFields = new Set(fields.map(f => f.id)), values = candidates.filter(v => fileFields.has(v.fieldId));
  const ids = [...new Set([...bindings.map(b => b.entityId), ...values.map(v => v.itemId)])];
  if (!ids.length) return;
  if (purpose === 'PUBLIC') throw new AppError('PERMISSION_DENIED', 'Private Item content cannot be published.', 403);
  const actor = await resolvePrincipal(tx, workspaceId, userId);
  const items = await tx.spaItem.findMany({ where: { workspaceId, id: { in: ids }, status: { not: 'TRASHED' } } });
  if (items.length !== ids.length) throw new AppError('PERMISSION_DENIED', 'Item content is unavailable.', 403);
  for (const item of items) {
    await policies.assertItem(tx, actor, item, purpose === 'EDIT' ? 'SPA.ITEM.UPDATE' : 'SPA.ITEM.READ');
    for (const value of values.filter(v => v.itemId === item.id)) if (!(await policies.fieldAccess(tx, actor, item.typeId, value.fieldId)).canView)
      throw new AppError('PERMISSION_DENIED', 'Item field content is unavailable.', 403);
  }
}
