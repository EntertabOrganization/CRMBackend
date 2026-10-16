import { registerPrivacyHook } from './privacy-service';
import type { Tx } from './kernel';

/**
 * Module-owned privacy hooks for already-implemented domains. Each hook touches only its owner's tables,
 * keeps legally required commercial/audit history (AC04: audit_logs are never edited) and pages by id.
 */
const BATCH = 100;
async function contactIds(tx: Tx, workspaceId: string, subjectRef: string, cursor: string | null) {
  const [kind, value] = [subjectRef.slice(0, subjectRef.indexOf(':')), subjectRef.slice(subjectRef.indexOf(':') + 1)];
  if (kind === 'contact') return cursor ? [] : [value];
  if (kind !== 'email') return [];
  const rows = await tx.crmContactCommunication.findMany({ where: { workspaceId, type: 'EMAIL', normalizedValue: value, ...(cursor ? { contactId: { gt: cursor } } : {}) }, orderBy: { contactId: 'asc' }, distinct: ['contactId'], take: BATCH, select: { contactId: true } });
  return rows.map(r => r.contactId);
}

registerPrivacyHook({ moduleCode: 'crm.contacts', category: 'customer_records',
  async export(tx, workspaceId, subjectRef, cursor) {
    const ids = await contactIds(tx, workspaceId, subjectRef, cursor);
    const contacts = await tx.crmContact.findMany({ where: { workspaceId, id: { in: ids }, isDeleted: false },
      select: { id: true, firstName: true, lastName: true, displayName: true, addressLine1: true, addressLine2: true, city: true, stateOrProvince: true, postalCode: true, countryCode: true, createdAt: true } });
    const comms = await tx.crmContactCommunication.findMany({ where: { workspaceId, contactId: { in: ids } }, select: { contactId: true, type: true, value: true, label: true } });
    return { items: contacts.map(c => ({ ...c, communications: comms.filter(x => x.contactId === c.id).map(({ contactId: _c, ...rest }) => rest) })), nextCursor: ids.length === BATCH ? ids[ids.length - 1] : null };
  },
  async erase(tx, workspaceId, subjectRef, cursor) {
    const ids = await contactIds(tx, workspaceId, subjectRef, cursor);
    const holds = await tx.suiteLegalHold.findMany({ where: { workspaceId, releasedAt: null, scopeId: { in: ids } }, select: { scopeId: true } });
    const held = new Set(holds.map(h => h.scopeId)), targets = ids.filter(id => !held.has(id));
    // Anonymize in place (keeps deal/invoice references valid); contact channels are removed.
    await tx.crmContact.updateMany({ where: { workspaceId, id: { in: targets } }, data: { firstName: 'Erased', lastName: 'Subject', displayName: 'Erased subject', addressLine1: null, addressLine2: null, city: null, stateOrProvince: null, postalCode: null, version: { increment: 1 } } });
    await tx.crmContactCommunication.deleteMany({ where: { workspaceId, contactId: { in: targets } } });
    return { processed: targets.length, nextCursor: ids.length === BATCH ? ids[ids.length - 1] : null, retained: [...held].filter(Boolean) as string[] };
  } });

registerPrivacyHook({ moduleCode: 'platform.notifications', category: 'communications',
  async export(tx, workspaceId, subjectRef, cursor) {
    if (!subjectRef.startsWith('user:')) return { items: [], nextCursor: null };
    const userId = subjectRef.slice(5);
    const rows = await tx.userNotification.findMany({ where: { workspaceId, recipientUserId: userId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: BATCH, select: { id: true, title: true, message: true, topic: true, createdAt: true, readAt: true } });
    return { items: rows, nextCursor: rows.length === BATCH ? rows[rows.length - 1].id : null };
  },
  async erase(tx, workspaceId, subjectRef, cursor) {
    if (!subjectRef.startsWith('user:')) return { processed: 0, nextCursor: null };
    const userId = subjectRef.slice(5);
    const rows = await tx.userNotification.findMany({ where: { workspaceId, recipientUserId: userId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: BATCH, select: { id: true } });
    await tx.userNotification.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
    await tx.recentItem.deleteMany({ where: { workspaceId, userId } });
    await tx.favorite.deleteMany({ where: { workspaceId, userId } });
    return { processed: rows.length, nextCursor: rows.length === BATCH ? rows[rows.length - 1].id : null };
  } });
