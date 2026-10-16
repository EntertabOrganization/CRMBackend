import type { MarketingCampaign, MarketingSegment } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { decrypt, destinationHash, entitled, notFound, normalizeDestination, zoneOffsetMinutes } from '../suite/kernel';

export const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'] as const;
export type Channel = typeof CHANNELS[number];
export const channel = z.enum(CHANNELS);

/** Allowlisted declarative filter AST for dynamic segments; never raw SQL or ORM paths. */
const FIELDS = { firstName: 'text', lastName: 'text', displayName: 'text', city: 'text', countryCode: 'text', stateOrProvince: 'text', postalCode: 'text', createdAt: 'date', responsibleUserId: 'uuid', emailDomain: 'text' } as const;
const OPERATORS = ['eq', 'neq', 'in', 'notIn', 'contains', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'isNull'] as const;
const rule = z.strictObject({ field: z.enum(Object.keys(FIELDS) as [keyof typeof FIELDS, ...(keyof typeof FIELDS)[]]), operator: z.enum(OPERATORS), value: z.union([z.string().max(200), z.array(z.string().max(200)).max(200), z.null()]).optional() });
type Rule = z.infer<typeof rule>; type Group = { op: 'AND' | 'OR'; rules: (Rule | Group)[] };
export const ruleTree: z.ZodType<Group> = z.lazy(() => z.strictObject({ op: z.enum(['AND', 'OR']), rules: z.array(z.union([rule, ruleTree])).min(1).max(50) }));

type ContactRow = { id: string; firstName: string; lastName: string; displayName: string; city: string | null; countryCode: string | null; stateOrProvince: string | null; postalCode: string | null; createdAt: Date; responsibleUserId: string; email?: string | null };
function test(row: ContactRow, r: Rule): boolean {
  const raw = r.field === 'emailDomain' ? row.email?.split('@')[1] ?? null : (row as unknown as Record<string, unknown>)[r.field];
  const value = raw instanceof Date ? raw.toISOString() : raw === null || raw === undefined ? null : String(raw);
  const v = r.value, cmp = (x: string): number => value === null ? Number.NaN : FIELDS[r.field] === 'date' ? Date.parse(value) - Date.parse(x) : value.localeCompare(x);
  switch (r.operator) {
    case 'isNull': return value === null;
    case 'eq': return typeof v === 'string' && value?.toLowerCase() === v.toLowerCase();
    case 'neq': return typeof v === 'string' && value?.toLowerCase() !== v.toLowerCase();
    case 'in': return Array.isArray(v) && value !== null && v.map(x => x.toLowerCase()).includes(value.toLowerCase());
    case 'notIn': return Array.isArray(v) && (value === null || !v.map(x => x.toLowerCase()).includes(value.toLowerCase()));
    case 'contains': return typeof v === 'string' && value !== null && value.toLowerCase().includes(v.toLowerCase());
    case 'startsWith': return typeof v === 'string' && value !== null && value.toLowerCase().startsWith(v.toLowerCase());
    case 'gt': return typeof v === 'string' && cmp(v) > 0;
    case 'gte': return typeof v === 'string' && cmp(v) >= 0;
    case 'lt': return typeof v === 'string' && cmp(v) < 0;
    case 'lte': return typeof v === 'string' && cmp(v) <= 0;
  }
}
function evaluate(row: ContactRow, group: Group): boolean {
  const results = group.rules.map(r => 'op' in r ? evaluate(row, r) : test(row, r));
  return group.op === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

/** CRM port: Contacts readable by the actor (crm.contact.read + owner scope), with primary destination per channel. */
export async function queryEligibleContacts(tx: Tx, actor: Principal, tree: Group | null, ch: Channel, contactIds?: string[]) {
  requirePermission(actor, 'crm.contact.read');
  const contacts = await tx.crmContact.findMany({ where: { workspaceId: actor.workspaceId, isDeleted: false, isArchived: false, ...(contactIds ? { id: { in: contactIds } } : {}) }, orderBy: { id: 'asc' }, take: 50000 });
  const comms = await tx.crmContactCommunication.findMany({ where: { workspaceId: actor.workspaceId, contactId: { in: contacts.map(c => c.id) }, type: ch === 'EMAIL' ? 'EMAIL' : 'PHONE' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
  const out: { ref: string; destination: string }[] = [];
  for (const contact of contacts) {
    if (!await ownerVisible(tx, actor, contact.responsibleUserId, 'crm.contact.read')) continue;
    const comm = comms.find(c => c.contactId === contact.id), destination = comm ? normalizeDestination(ch, comm.normalizedValue || comm.value) : null;
    if (tree && !evaluate({ ...contact, email: ch === 'EMAIL' ? destination : null }, tree)) continue;
    if (destination) out.push({ ref: 'CONTACT:' + contact.id, destination });
  }
  return out;
}

/** Resolves current segment members (static members, dynamic rules) minus exclusion segments; deduped by destination. */
export async function resolveSegment(tx: Tx, actor: Principal, segment: MarketingSegment, depth = 0): Promise<Map<string, { ref: string; destination: string }>> {
  if (depth > 3) throw new AppError('VALIDATION_FAILED', 'Exclusion nesting is too deep.', 400);
  const ch = segment.channel as Channel, result = new Map<string, { ref: string; destination: string }>();
  if (segment.kind === 'DYNAMIC') for (const row of await queryEligibleContacts(tx, actor, ruleTree.parse(segment.ruleTree), ch)) result.set(destinationHash(ch, row.destination), row);
  else {
    const members = await tx.marketingSegmentMember.findMany({ where: { workspaceId: actor.workspaceId, segmentId: segment.id, removedAt: null } });
    const contactIds = members.filter(m => m.identityRef.startsWith('CONTACT:')).map(m => m.identityRef.slice(8));
    for (const row of contactIds.length ? await queryEligibleContacts(tx, actor, null, ch, contactIds) : []) result.set(destinationHash(ch, row.destination), row);
    const identityIds = members.filter(m => m.identityRef.startsWith('AUDIENCE:')).map(m => m.identityRef.slice(9));
    for (const identity of await tx.marketingAudienceIdentity.findMany({ where: { workspaceId: actor.workspaceId, channel: ch, id: { in: identityIds } } }))
      result.set(identity.destinationHash, { ref: 'AUDIENCE:' + identity.id, destination: decrypt(identity.destinationEncrypted)! });
  }
  for (const excludedId of (segment.exclusions as string[]) ?? []) {
    const excluded = await tx.marketingSegment.findFirst({ where: { workspaceId: actor.workspaceId, id: excludedId } });
    if (excluded) for (const key of (await resolveSegment(tx, actor, excluded, depth + 1)).keys()) result.delete(key);
  }
  return result;
}

export type Eligibility = 'ELIGIBLE' | 'SUPPRESSED' | 'UNKNOWN_CONSENT' | 'FREQUENCY_BLOCKED' | 'QUIET_HOURS' | 'INVALID_DESTINATION' | 'POLICY_MISSING';
/** Evaluated at snapshot, at queue AND immediately before each provider call. Suppression always wins. */
export async function eligibility(tx: Tx, workspaceId: string, input: { destinationHash: string; channel: string; purpose: string; jurisdiction: string; timezone?: string; at?: Date; campaignId?: string }): Promise<Eligibility> {
  const at = input.at ?? new Date();
  const suppressed = await tx.marketingSuppression.findFirst({ where: { workspaceId, destinationHash: input.destinationHash, channel: { in: [input.channel, 'ALL'] }, liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] } });
  if (suppressed) return 'SUPPRESSED';
  if (input.purpose === 'TRANSACTIONAL') return 'ELIGIBLE';
  const policy = await tx.marketingConsentPolicy.findFirst({ where: { workspaceId, channel: input.channel, purpose: input.purpose, jurisdiction: { in: [input.jurisdiction, 'DEFAULT'] } }, orderBy: { jurisdiction: input.jurisdiction === 'DEFAULT' ? 'asc' : 'desc' } });
  if (!policy) return 'POLICY_MISSING';
  if (policy.consentRequired) {
    const latest = await tx.marketingConsentRecord.findFirst({ where: { workspaceId, destinationHash: input.destinationHash, channel: input.channel, purpose: input.purpose, effectiveAt: { lte: at } }, orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }] });
    if (latest?.state !== 'GRANTED') return 'UNKNOWN_CONSENT';
  }
  const quiet = policy.quietHours as { start?: string; end?: string; timezone?: string };
  if (quiet.start && quiet.end) {
    const zone = quiet.timezone ?? input.timezone ?? 'UTC', local = new Date(at.getTime() + zoneOffsetMinutes(at, zone) * 60000), hhmm = local.toISOString().slice(11, 16);
    const inQuiet = quiet.start <= quiet.end ? hhmm >= quiet.start && hhmm < quiet.end : hhmm >= quiet.start || hhmm < quiet.end;
    if (inQuiet) return 'QUIET_HOURS';
  }
  const cap = policy.frequencyCap as { maxMessages?: number; windowHours?: number };
  if (cap.maxMessages && cap.windowHours) {
    const sent = await tx.marketingDelivery.count({ where: { workspaceId, destinationHash: input.destinationHash, channel: input.channel, isTest: false, state: { in: ['ACCEPTED', 'DELIVERED', 'SENDING'] },
      sentAt: { gte: new Date(at.getTime() - cap.windowHours * 3600000) }, ...(input.campaignId ? { campaignId: { not: input.campaignId } } : {}) } });
    if (sent >= cap.maxMessages) return 'FREQUENCY_BLOCKED';
  }
  return 'ELIGIBLE';
}

export async function loadSegment(tx: Tx, actor: Principal, id: string, permission: string) {
  requirePermission(actor, permission); entitled(actor, 'marketing');
  const row = await tx.marketingSegment.findFirst({ where: { workspaceId: actor.workspaceId, id } });
  if (!row || !await ownerVisible(tx, actor, row.ownerUserId, permission)) throw notFound('Segment');
  return row;
}
export async function loadCampaign(tx: Tx, actor: Principal, id: string, permission: string): Promise<MarketingCampaign> {
  requirePermission(actor, permission); entitled(actor, 'marketing');
  const row = await tx.marketingCampaign.findFirst({ where: { workspaceId: actor.workspaceId, id } });
  if (!row || !await ownerVisible(tx, actor, row.createdByUserId, permission)) throw notFound('Campaign');
  return row;
}
export function destinationOf(ch: Channel, raw: string) {
  const normalized = normalizeDestination(ch, raw);
  if (!normalized) throw new AppError('VALIDATION_FAILED', 'Destination is invalid for the channel.', 400, { fields: [{ field: 'destination', reason: 'INVALID_DESTINATION' }] });
  return { normalized, hash: destinationHash(ch, normalized) };
}
