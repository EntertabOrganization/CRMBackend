import { createHmac, randomUUID } from 'node:crypto';
import type { MarketingCampaign } from '@prisma/client';
import type { Generic, Probe } from './probe';
import { seedDriveFile } from './files';

const M = '/api/v1/marketing';
type World = Awaited<ReturnType<typeof import('./fixtures')['marketingWorld']>>;
const m = (p: Probe) => p.x.m as World;
const svc = () => import('../../../src/server/marketing/routes');
const providers = () => import('../../../src/server/suite/providers');

async function fresh(p: Probe, emails = ['carol-' + randomUUID().slice(0, 6) + '@example.test'], consent = true) {
  const contacts = []; for (const e of emails) contacts.push(await m(p).contact(e, consent));
  const segment = await m(p).segment(contacts.map(c => c.id));
  return { contacts, segment, campaign: await m(p).approvedCampaign(segment.id) };
}
async function launch(p: Probe, c: Pick<MarketingCampaign, 'id' | 'version' | 'approvedRevision'>, key = p.key('launch')) {
  return p.req('marketer', 'POST', `${M}/campaigns/${c.id}/launch`, { expectedVersion: c.version, approvedRevision: c.approvedRevision }, { 'Idempotency-Key': key });
}
const deliveries = (p: Probe, campaignId: string) => p.q(db => db.marketingDelivery.findMany({ where: { campaignId, isTest: false }, orderBy: { id: 'asc' } }));
async function work(p: Probe, id: string) { const { marketingDeliveries } = await svc(); return p.call(() => marketingDeliveries.process(id)); }
const due = (p: Probe, campaignId: string) => p.q(db => db.marketingDelivery.updateMany({ where: { campaignId }, data: { nextAttemptAt: new Date(Date.now() - 1000), leaseExpiresAt: null, leaseToken: null } }));
const calls = (p: Probe, campaignId: string) => p.q(db => db.suiteProviderCall.count({ where: { campaignId, operation: 'SEND' } }));
async function csvImport(p: Probe, segmentId: string, csv: string, key = p.key('import')) {
  const file = await seedDriveFile(p.db, p.f.workspaceId, p.w.users.marketer.id, Buffer.from(csv), 'audience.csv');
  const created = await p.req('marketer', 'POST', `${M}/audiences/import-jobs`, { fileId: file.id, segmentId, channel: 'EMAIL', fieldMapping: { destination: 'email', firstName: 'first_name' } }, { 'Idempotency-Key': key });
  return { file, created };
}
function webhook(p: Probe, body: Record<string, unknown>) {
  const raw = JSON.stringify(body), signature = createHmac('sha256', process.env.SANDBOX_WEBHOOK!).update(raw).digest('hex');
  return p.req('guest', 'POST', '/api/v1/integrations/marketing/sandbox/webhook', body, { 'x-connection-id': m(p).connection.id, 'x-sandbox-signature': signature });
}

export const marketingGeneric: Generic = {
  scenario: 'marketing_campaign',
  async foreign(p) { return { actor: 'marketer', path: `${M}/segments/${p.ids.foreignSegmentId}` }; },
  async mutation(p) {
    return { actor: 'marketer', deniedActor: 'employee', req: { method: 'POST', path: `${M}/segments`, body: { name: 'Generic ' + randomUUID().slice(0, 6), kind: 'STATIC', channel: 'EMAIL' } },
      count: () => p.q(db => db.marketingSegment.count({ where: { workspaceId: p.f.workspaceId } })), resourceId: res => res.body.data?.id };
  },
  async idempotent(p) {
    const { campaign } = await fresh(p);
    return { actor: 'marketer', req: { method: 'POST', path: `${M}/campaigns/${campaign.id}/launch`, body: { expectedVersion: campaign.version, approvedRevision: campaign.approvedRevision } },
      count: () => p.q(db => db.marketingDelivery.count({ where: { campaignId: campaign.id } })), id: res => res.body.data?.id };
  },
};

export const marketingCases: Record<string, (p: Probe) => Promise<void>> = {
  // ------------------------------------------------------------ 01 segments
  async '01-segments-and-audiences::AC01'(p) {
    const { segment, campaign } = await fresh(p, ['f1-' + randomUUID().slice(0, 6) + '@example.test', 'f2-' + randomUUID().slice(0, 6) + '@example.test']);
    const frozen = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/audience-snapshot`, {});
    p.ok('snapshot frozen', frozen);
    const late = await m(p).contact('late-' + randomUUID().slice(0, 6) + '@example.test');
    p.ok('CRM membership edited after freeze', await p.req('marketer', 'POST', `${M}/segments/${segment.id}/members`, { contactIds: [late.id] }));
    const preview = await p.req('marketer', 'GET', `${M}/campaigns/${campaign.id}/audience-preview`);
    p.check('frozen campaign count unchanged', preview.body.data?.frozen === true && preview.body.data?.targetCount === 2, preview.body.data);
    p.check('snapshot recipients unchanged', (await p.q(db => db.marketingAudienceRecipient.count({ where: { campaignId: campaign.id } }))) === 2);
  },
  async '01-segments-and-audiences::AC02'(p) {
    const city = 'City' + randomUUID().slice(0, 6);
    const a = await m(p).contact('dyn-' + randomUUID().slice(0, 6) + '@example.test');
    await p.q(db => db.crmContact.update({ where: { id: a.id }, data: { city } as never }));
    const dynamic = await p.req('marketer', 'POST', `${M}/segments`, { name: 'Dynamic', kind: 'DYNAMIC', channel: 'EMAIL', ruleTree: { op: 'AND', rules: [{ field: 'city', operator: 'eq', value: city }] } });
    const stat = await m(p).segment([a.id]);
    const count = async (id: string) => (await p.req('marketer', 'POST', `${M}/segments/${id}/preview`, {})).body.data?.count as number;
    const [d1, s1] = [await count(dynamic.body.data.id), await count(stat.id)];
    const b = await m(p).contact('dyn2-' + randomUUID().slice(0, 6) + '@example.test');
    await p.q(db => db.crmContact.update({ where: { id: b.id }, data: { city } as never }));
    const [d2, s2] = [await count(dynamic.body.data.id), await count(stat.id)];
    p.check('dynamic preview reflects the CRM change', d2 === d1 + 1, { d1, d2 });
    p.check('static segment unchanged', s2 === s1, { s1, s2 });
  },
  async '01-segments-and-audiences::AC03'(p) {
    const res = await launch(p, { id: p.ids.campaignId, version: Number(p.f.metadata?.campaignVersion), approvedRevision: Number(p.f.metadata?.approvedRevision) });
    p.ok('campaign launched', res);
    const rows = await deliveries(p, p.ids.campaignId);
    p.check('suppressed recipient never queued', rows.every(d => d.destinationHash !== p.ids.optedOutDestinationHash), rows.length);
    const recipient = await p.q(db => db.marketingAudienceRecipient.findFirst({ where: { campaignId: p.ids.campaignId, destinationHash: p.ids.optedOutDestinationHash } }));
    p.check('suppression captured in the frozen snapshot', recipient?.eligibilityState === 'SUPPRESSED', recipient?.eligibilityState);
  },
  // ------------------------------------------------------------ 02 imports
  async '02-audience-imports::AC01'(p) {
    const segment = await m(p).segment([]);
    const { created } = await csvImport(p, segment.id, 'email,first_name\nok-' + randomUUID().slice(0, 6) + '@example.test,Ok\nnot-an-email,Bad\n');
    p.ok('import validated', created);
    p.check('bad row reported at validation', created.body.data?.rejectedCount === 1, created.body.data);
    const done = await p.req('marketer', 'POST', `${M}/audiences/import-jobs/${created.body.data?.id}/confirm`, {});
    p.ok('import confirmed', done);
    p.check('partial success status', done.body.data?.status === 'PARTIAL' && done.body.data?.importedCount === 1, done.body.data);
    const errors = await p.req('marketer', 'GET', `${M}/audiences/import-jobs/${created.body.data?.id}/errors`);
    p.check('error rows downloadable without raw destinations', Array.isArray(errors.body.data) && errors.body.data.some((r: { errorCode: string }) => r.errorCode === 'INVALID_DESTINATION'));
  },
  async '02-audience-imports::AC02'(p) {
    const segment = await m(p).segment([]), csv = 'email,first_name\nre-' + randomUUID().slice(0, 6) + '@example.test,A\nre2-' + randomUUID().slice(0, 6) + '@example.test,B\n';
    for (let i = 0; i < 2; i++) {
      const { created } = await csvImport(p, segment.id, csv);
      p.ok('import ' + (i + 1) + ' validated', created);
      p.ok('import ' + (i + 1) + ' confirmed', await p.req('marketer', 'POST', `${M}/audiences/import-jobs/${created.body.data?.id}/confirm`, {}));
    }
    p.check('identities not duplicated', (await p.q(db => db.marketingAudienceIdentity.count({ where: { workspaceId: p.f.workspaceId } }))) === 2);
    p.check('segment membership not duplicated', (await p.q(db => db.marketingSegmentMember.count({ where: { segmentId: segment.id, removedAt: null } }))) === 2);
  },
  async '02-audience-imports::AC03'(p) {
    const segment = await m(p).segment([]), { created } = await csvImport(p, segment.id, 'email,first_name\nimp-' + randomUUID().slice(0, 6) + '@example.test,Imp\n');
    await p.req('marketer', 'POST', `${M}/audiences/import-jobs/${created.body.data?.id}/confirm`, {});
    const campaign = await m(p).approvedCampaign(segment.id);
    p.ok('campaign launched', await launch(p, campaign));
    p.check('no delivery queued without consent', (await deliveries(p, campaign.id)).length === 0);
    const recipient = await p.q(db => db.marketingAudienceRecipient.findFirst({ where: { campaignId: campaign.id } }));
    p.check('recipient classified UNKNOWN_CONSENT', recipient?.eligibilityState === 'UNKNOWN_CONSENT', recipient?.eligibilityState);
  },
  // ------------------------------------------------------------ 03 consent
  async '03-consent-and-suppression::AC01'(p) {
    const email = 'late-unsub-' + randomUUID().slice(0, 6) + '@example.test', { campaign } = await fresh(p, [email]);
    p.ok('launched', await launch(p, campaign));
    const [delivery] = await deliveries(p, campaign.id);
    const { destinationHash } = await import('../../../src/server/suite/kernel');
    const { MarketingConsentService } = await import('../../../src/server/marketing/consent-service');
    const token = await p.q(db => db.$transaction(tx => MarketingConsentService.issueOptout(tx, p.f.workspaceId, destinationHash('EMAIL', email), 'EMAIL', campaign.id)));
    p.ok('one-click unsubscribe', await p.req('guest', 'POST', '/api/v1/public/marketing/unsubscribe', { token }));
    await work(p, delivery.id);
    const after = await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }));
    p.check('queued delivery suppressed before send', after.state === 'SUPPRESSED', after.state);
    p.check('no provider send', (await calls(p, campaign.id)) === 0);
  },
  async '03-consent-and-suppression::AC02'(p) {
    const email = 'complain-' + randomUUID().slice(0, 6) + '@example.test', { segment, campaign } = await fresh(p, [email]);
    await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id); await work(p, delivery.id);
    const hook = await webhook(p, { eventId: 'cmp-' + randomUUID(), deliveryId: delivery.id, status: 'COMPLAINED', occurredAt: new Date().toISOString() });
    p.ok('signed complaint accepted', hook);
    const next = await m(p).approvedCampaign(segment.id);
    p.ok('next campaign launched', await launch(p, next));
    p.check('complainant excluded from the next campaign', (await deliveries(p, next.id)).length === 0);
    p.check('ALL-channel complaint suppression recorded', (await p.obs('suppression_entries', { destinationHash: delivery.destinationHash })).some(s => s.reason === 'COMPLAINT'));
  },
  async '03-consent-and-suppression::AC03'(p) {
    const email = 'noinfer-' + randomUUID().slice(0, 6) + '@example.test', segment = await m(p).segment([]);
    const { created } = await csvImport(p, segment.id, 'email,first_name\n' + email + ',N\n');
    await p.req('marketer', 'POST', `${M}/audiences/import-jobs/${created.body.data?.id}/confirm`, {});
    const preview = await p.req('marketer', 'POST', `${M}/eligibility/preview`, { subject: { destination: email }, channel: 'EMAIL', purpose: 'MARKETING' });
    p.check('imported subject has unknown consent', preview.body.data?.eligibility === 'UNKNOWN_CONSENT', preview.body.data);
    p.check('no consent record inferred', (await p.q(db => db.marketingConsentRecord.count({ where: { destinationHash: preview.body.data?.destinationHash } }))) === 0);
  },
  // ------------------------------------------------------------ 04 sender & provider
  async '04-sender-and-provider-config::AC01'(p) {
    const sender = await p.req('marketer', 'POST', `${M}/senders`, { channel: 'EMAIL', displayName: 'Unverified', address: 'unverified@sender.example.test', providerConnectionId: m(p).connection.id });
    const contact = await m(p).contact('u-' + randomUUID().slice(0, 6) + '@example.test'), segment = await m(p).segment([contact.id]);
    const created = await p.req('marketer', 'POST', `${M}/campaigns`, { name: 'Unverified sender', channel: 'EMAIL', segmentId: segment.id, senderIdentityId: sender.body.data?.id, templateVersionId: m(p).v1.id });
    const submit = await p.req('marketer', 'POST', `${M}/campaigns/${created.body.data?.id}/submit-approval`, { expectedVersion: created.body.data?.version });
    p.status('unverified sender blocks the approval/schedule path', submit, [409]); p.code('sender not verified', submit, ['SENDER_NOT_VERIFIED']);
    p.check('campaign stays DRAFT', (await p.q(db => db.marketingCampaign.findUniqueOrThrow({ where: { id: created.body.data?.id } }))).status === 'DRAFT');
  },
  async '04-sender-and-provider-config::AC02'(p) {
    const { campaign } = await fresh(p); await launch(p, campaign);
    p.ok('provider credentials revoked/disabled', await p.req('marketer', 'POST', `${M}/providers/${m(p).connection.id}/disable`, {}));
    const rows = await deliveries(p, campaign.id);
    p.check('unattempted deliveries paused (DEFERRED)', rows.length > 0 && rows.every(d => d.state === 'DEFERRED' && d.lastErrorCode === 'PROVIDER_CREDENTIALS_UNAVAILABLE'), rows.map(d => d.state));
    await due(p, campaign.id); for (const d of rows) await work(p, d.id);
    p.check('no send while credentials unavailable', (await calls(p, campaign.id)) === 0);
  },
  async '04-sender-and-provider-config::AC03'(p) {
    const { setSandboxBehavior } = await providers(), { campaign } = await fresh(p); await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id);
    setSandboxBehavior(m(p).connection.id, 'QUOTA'); await work(p, delivery.id);
    const deferred = await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }));
    p.check('quota response defers the delivery', deferred.state === 'DEFERRED' && deferred.lastErrorCode === 'PROVIDER_QUOTA', deferred.state);
    setSandboxBehavior(m(p).connection.id, 'ACCEPT'); await due(p, campaign.id); await work(p, delivery.id);
    p.check('delivered once after the quota window', (await calls(p, campaign.id)) === 1);
    p.check('single accepted delivery', (await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))).state === 'ACCEPTED');
  },
  // ------------------------------------------------------------ 05 templates
  async '05-templates-and-content::AC01'(p) {
    const { campaign } = await fresh(p); await launch(p, campaign);
    const v = await p.req('marketer', 'POST', `${M}/templates/${m(p).template.id}/versions`, { subject: 'Changed', bodyText: 'Changed body {{unsubscribeUrl}}' });
    p.ok('new template version created', v);
    p.ok('new version approved', await p.req('owner', 'POST', `${M}/templates/${m(p).template.id}/versions/${v.body.data?.versionNo}/approve`, {}));
    const rows = await deliveries(p, campaign.id);
    p.check('queued deliveries keep the frozen template version', rows.length > 0 && rows.every(d => d.templateVersionId === m(p).v1.id));
  },
  async '05-templates-and-content::AC02'(p) {
    const res = await p.req('marketer', 'POST', `${M}/templates/${m(p).template.id}/versions`, { subject: 'Hi {{shoeSize}}', bodyText: 'Body {{shoeSize}} {{unsubscribeUrl}}' });
    p.status('unknown personalization token rejected', res, [400]);
    p.check('reason names the unknown variable', JSON.stringify(res.body.error?.details ?? {}).includes('UNKNOWN_VARIABLE'));
    p.check('no version persisted with the unknown token', (await p.q(db => db.marketingTemplateVersion.count({ where: { templateId: m(p).template.id, bodyText: { contains: 'shoeSize' } } }))) === 0);
  },
  async '05-templates-and-content::AC03'(p) {
    const { campaign } = await fresh(p);
    const res = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/test-send`, { destination: p.w.users.marketer.email });
    p.ok('test send accepted', res);
    const metrics = await p.req('marketer', 'GET', `${M}/campaigns/${campaign.id}/metrics`);
    p.check('test delivery excluded from live metrics', metrics.body.data?.attempted === 0 && metrics.body.data?.accepted === 0, metrics.body.data);
    p.check('test delivery marked TEST', (await p.q(db => db.marketingDelivery.count({ where: { campaignId: campaign.id, isTest: true } }))) === 1);
  },
  // ------------------------------------------------------------ 06 campaigns & approvals
  async '06-campaigns-and-approvals::AC01'(p) {
    const v2 = await p.req('marketer', 'POST', `${M}/templates/${m(p).template.id}/versions`, { subject: 'V2', bodyText: 'V2 {{unsubscribeUrl}}' });
    const { campaign } = await fresh(p);
    const patched = await p.req('marketer', 'PATCH', `${M}/campaigns/${campaign.id}`, { templateVersionId: v2.body.data?.id });
    p.ok('material change saved', patched);
    p.check('approval invalidated (DRAFT, no approved revision)', patched.body.data?.status === 'DRAFT' && patched.body.data?.approvedRevision === null, patched.body.data);
    const stale = await launch(p, { id: campaign.id, version: patched.body.data?.version, approvedRevision: campaign.approvedRevision });
    p.status('old approval cannot launch', stale, [409]);
    p.check('approval row invalidated', (await p.q(db => db.marketingCampaignApproval.count({ where: { campaignId: campaign.id, state: 'INVALIDATED' } }))) === 1);
  },
  async '06-campaigns-and-approvals::AC02'(p) {
    const { campaign } = await fresh(p), key = p.key('dst');
    const body = { expectedVersion: campaign.version, approvedRevision: campaign.approvedRevision, scheduledLocal: '2026-11-01T01:30', timezone: 'America/New_York', costAcknowledged: true };
    const a = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/schedule`, body, { 'Idempotency-Key': key });
    const b = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/schedule`, body, { 'Idempotency-Key': key });
    p.ok('ambiguous DST local time scheduled', a); p.ok('repeat returns the same schedule', b);
    const rows = await p.q(db => db.marketingCampaignSchedule.findMany({ where: { campaignId: campaign.id } }));
    p.check('exactly one run instant exists', rows.length === 1 && rows[0].executionKey.endsWith(rows[0].runAt.toISOString()), rows.map(r => r.runAt));
  },
  async '06-campaigns-and-approvals::AC03'(p) {
    const { campaign } = await fresh(p); await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id); await work(p, delivery.id);
    p.ok('paused mid-send', await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/pause`, {}));
    p.ok('resumed', await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/resume`, {}));
    await due(p, campaign.id); await work(p, delivery.id);
    p.check('accepted message never resent', (await calls(p, campaign.id)) === 1);
    p.check('delivery stays ACCEPTED', (await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))).state === 'ACCEPTED');
  },
  // ------------------------------------------------------------ 07 delivery jobs
  async '07-delivery-jobs-and-retries::AC01'(p) {
    const { campaign } = await fresh(p); await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id);
    await Promise.all([work(p, delivery.id), work(p, delivery.id)]);
    p.check('one provider send for concurrent workers', (await calls(p, campaign.id)) === 1);
    p.check('one attempt recorded', (await p.q(db => db.marketingDeliveryAttempt.count({ where: { deliveryId: delivery.id } }))) === 1);
  },
  async '07-delivery-jobs-and-retries::AC02'(p) {
    const email = 'q-' + randomUUID().slice(0, 6) + '@example.test', { campaign } = await fresh(p, [email]); await launch(p, campaign);
    p.ok('consent withdrawn while queued', await p.req('marketer', 'POST', `${M}/consents/withdraw`, { subject: { destination: email }, channel: 'EMAIL', purpose: 'MARKETING' }));
    const [delivery] = await deliveries(p, campaign.id); await work(p, delivery.id);
    p.check('queued delivery becomes SUPPRESSED', delivery.state === 'SUPPRESSED' || (await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))).state === 'SUPPRESSED');
    p.check('no provider call', (await calls(p, campaign.id)) === 0);
  },
  async '07-delivery-jobs-and-retries::AC03'(p) {
    const { setSandboxBehavior } = await providers(), { campaign } = await fresh(p); await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id);
    setSandboxBehavior(m(p).connection.id, 'TIMEOUT_AFTER_ACCEPT'); await work(p, delivery.id);
    setSandboxBehavior(m(p).connection.id, 'ACCEPT'); await due(p, campaign.id); await work(p, delivery.id);
    const row = await p.q(db => db.marketingDelivery.findUniqueOrThrow({ where: { id: delivery.id } }));
    p.check('uncertain outcome reconciled as ACCEPTED', row.state === 'ACCEPTED', row.state);
    p.check('no second send attempt', (await p.q(db => db.marketingDeliveryAttempt.count({ where: { deliveryId: delivery.id } }))) === 1);
    p.check('one provider effect recorded', (await calls(p, campaign.id)) === 1);
  },
  // ------------------------------------------------------------ 08 engagement
  async '08-engagement-and-conversions::AC01'(p) {
    const { campaign } = await fresh(p);
    const link = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/tracking-links`, { destinationUrl: 'https://shop.example.test/offer' });
    p.ok('tracking link created', link);
    const recipientKey = 'a'.repeat(64);
    for (let i = 0; i < 2; i++) p.ok('click ' + (i + 1), await p.req('guest', 'GET', `/api/v1/public/marketing/track/${link.body.data?.token}?r=${recipientKey}`));
    const events = await p.obs('marketing_events', { campaignId: campaign.id });
    p.check('duplicate click counted once as unique', events.length === 2 && events.filter(e => e.isUnique).length === 1, events.map(e => e.isUnique));
  },
  async '08-engagement-and-conversions::AC02'(p) {
    const { campaign } = await fresh(p, ['r1-' + randomUUID().slice(0, 6) + '@example.test', 'r2-' + randomUUID().slice(0, 6) + '@example.test']);
    await launch(p, campaign); const [first] = await deliveries(p, campaign.id); await work(p, first.id);
    const metrics = await p.req('marketer', 'GET', `${M}/campaigns/${campaign.id}/metrics`);
    p.ok('metrics', metrics);
    p.check('targeted = eligible + ineligible', metrics.body.data?.reconciliation?.targetedEqualsEligiblePlusIneligible === true);
    p.check('eligible = attempted + skipped + pending', metrics.body.data?.reconciliation?.eligibleEqualsAttemptedPlusSkippedPlusPending === true, metrics.body.data);
  },
  async '08-engagement-and-conversions::AC03'(p) {
    const email = 'hist-' + randomUUID().slice(0, 6) + '@example.test', { campaign } = await fresh(p, [email]); await launch(p, campaign);
    const [delivery] = await deliveries(p, campaign.id); await work(p, delivery.id);
    await webhook(p, { eventId: 'clk-' + randomUUID(), deliveryId: delivery.id, status: 'CLICKED', occurredAt: new Date().toISOString(), url: 'https://shop.example.test' });
    const before = (await p.req('marketer', 'GET', `${M}/campaigns/${campaign.id}/metrics`)).body.data?.clicked?.unique;
    await p.req('marketer', 'POST', `${M}/consents/withdraw`, { subject: { destination: email }, channel: 'EMAIL', purpose: 'MARKETING' });
    const after = (await p.req('marketer', 'GET', `${M}/campaigns/${campaign.id}/metrics`)).body.data?.clicked?.unique;
    p.check('historical aggregate metrics preserved after opt-out', before === 1 && after === 1, { before, after });
    p.check('engagement rows keyed by pseudonymous recipient key only', (await p.obs('marketing_events', { campaignId: campaign.id })).every(e => /^[a-f0-9]{64}$/.test(e.recipientKey)));
  },
  // ------------------------------------------------------------ 09 experiments & journeys
  async '09-experiments-and-journeys::AC01'(p) {
    const { campaign } = await fresh(p);
    const res = await p.req('marketer', 'POST', `${M}/campaigns/${campaign.id}/experiments`, { metric: 'CLICK', minSample: 10, variants: [{ label: 'A', templateVersionId: m(p).v1.id, percentage: 60 }, { label: 'B', templateVersionId: m(p).v1.id, percentage: 30 }] });
    p.status('allocation not equal to 100 rejected', res, [400]);
    p.check('no experiment persisted', (await p.q(db => db.marketingExperiment.count({ where: { campaignId: campaign.id } }))) === 0);
  },
  async '09-experiments-and-journeys::AC02'(p) {
    const v2 = await p.req('marketer', 'POST', `${M}/templates/${m(p).template.id}/versions`, { subject: 'B', bodyText: 'Variant B {{unsubscribeUrl}}' });
    await p.req('owner', 'POST', `${M}/templates/${m(p).template.id}/versions/${v2.body.data?.versionNo}/approve`, {});
    const contact = await m(p).contact('ab-' + randomUUID().slice(0, 6) + '@example.test'), segment = await m(p).segment([contact.id]);
    const created = await p.req('marketer', 'POST', `${M}/campaigns`, { name: 'AB', channel: 'EMAIL', segmentId: segment.id, senderIdentityId: m(p).sender.id, templateVersionId: m(p).v1.id });
    const exp = await p.req('marketer', 'POST', `${M}/campaigns/${created.body.data?.id}/experiments`, { metric: 'CLICK', minSample: 10, seed: 'stable-seed', variants: [{ label: 'A', templateVersionId: m(p).v1.id, percentage: 50 }, { label: 'B', templateVersionId: v2.body.data?.id, percentage: 50 }] });
    p.ok('experiment created', exp);
    const current = await p.q(db => db.marketingCampaign.findUniqueOrThrow({ where: { id: created.body.data?.id } }));
    const submitted = await p.req('marketer', 'POST', `${M}/campaigns/${current.id}/submit-approval`, { expectedVersion: current.version });
    const approved = await p.req('owner', 'POST', `${M}/campaigns/${current.id}/approve`, { expectedVersion: submitted.body.data?.version, revision: submitted.body.data?.revision });
    const key = p.key('ab');
    await launch(p, approved.body.data, key); await launch(p, approved.body.data, key);
    const rows = await deliveries(p, current.id), experiment = await p.q(db => db.marketingExperiment.findUniqueOrThrow({ where: { campaignId: current.id } })), variants = await p.q(db => db.marketingVariant.findMany({ where: { experimentId: experiment.id } }));
    const { MarketingGrowthService } = await import('../../../src/server/marketing/growth-service');
    const expected = MarketingGrowthService.assignment('stable-seed', rows[0]?.recipientKey ?? '', variants.map(v => ({ id: v.id, percentage: Number(v.percentage) })));
    p.check('single delivery per recipient', rows.length === 1);
    p.check('recipient arm is the deterministic stable assignment', rows[0]?.variantId === expected && expected === MarketingGrowthService.assignment('stable-seed', rows[0].recipientKey, variants.map(v => ({ id: v.id, percentage: Number(v.percentage) }))));
  },
  async '09-experiments-and-journeys::AC03'(p) {
    const contact = await m(p).contact('j-' + randomUUID().slice(0, 6) + '@example.test');
    const journey = await p.q(db => db.marketingJourney.create({ data: { workspaceId: p.f.workspaceId, name: 'Engine outage', workflowDefinitionId: randomUUID(), workflowVersionId: randomUUID(), reentryPolicy: 'PROHIBIT_ACTIVE', status: 'ACTIVE', createdByUserId: p.w.users.marketer.id } }));
    const res = await p.req('marketer', 'POST', `${M}/journeys/${journey.id}/enroll`, { contactId: contact.id }, { 'Idempotency-Key': p.key('enroll') });
    p.status('engine failure surfaces as unavailable', res, [404, 503]);
    p.check('journey step not marked successful', (await p.q(db => db.marketingJourneyEnrollment.count({ where: { journeyId: journey.id, status: 'ACTIVE' } }))) === 0);
  },
  // ------------------------------------------------------------ 10 ads & repeat sales
  async '10-ad-platforms-and-repeat-sales::AC01'(p) {
    const email = 'ads-' + randomUUID().slice(0, 6) + '@example.test', contact = await m(p).contact(email);
    const { marketingConsent, marketingGrowth } = await svc();
    await p.call(() => marketingConsent.record(m(p).marketer, { subject: { destination: email }, channel: 'EMAIL', purpose: 'ADVERTISING', lawfulBasis: 'CONSENT', source: 'WEB_FORM', jurisdiction: 'DEFAULT' }));
    const segment = await m(p).segment([contact.id]);
    const conn = await p.req('marketer', 'POST', `${M}/ad-connections`, { platform: 'META', credentialSecretRef: 'env:META_ADS_TOKEN', externalAccountId: 'act-1', sandbox: true });
    const audience = await p.req('marketer', 'POST', `${M}/ad-audiences`, { connectionId: conn.body.data?.id, segmentId: segment.id });
    await p.req('marketer', 'POST', `${M}/ad-audiences/${audience.body.data?.id}/sync`, {}); await p.call(() => marketingGrowth.tickAdSync(10));
    const synced = await p.q(db => db.marketingAdAudience.findUniqueOrThrow({ where: { id: audience.body.data?.id } }));
    p.check('consented subject uploaded', (synced.syncedHashes as string[]).length === 1);
    await p.req('marketer', 'POST', `${M}/consents/withdraw`, { subject: { destination: email }, channel: 'EMAIL', purpose: 'ADVERTISING' });
    await p.req('marketer', 'POST', `${M}/ad-audiences/${audience.body.data?.id}/sync`, {}); await p.call(() => marketingGrowth.tickAdSync(10));
    const after = await p.q(db => db.marketingAdAudience.findUniqueOrThrow({ where: { id: audience.body.data?.id } }));
    p.check('withdrawn subject removed from the ad audience', (after.syncedHashes as string[]).length === 0);
    p.check('removal recorded on the sync job', (await p.q(db => db.marketingAdSyncJob.count({ where: { audienceId: audience.body.data?.id, removedCount: 1 } }))) === 1);
  },
  async '10-ad-platforms-and-repeat-sales::AC02'(p) {
    const conn = await p.req('marketer', 'POST', `${M}/ad-connections`, { platform: 'META', credentialSecretRef: 'env:META_ADS_TOKEN', externalAccountId: 'act-2', sandbox: true });
    const body = { connectionId: conn.body.data?.id, from: '2026-09-01', to: '2026-09-30', rows: [{ externalCampaignId: 'c1', currency: 'USD', spend: '12.50', impressions: 1000, clicks: 20 }] };
    const a = await p.req('marketer', 'POST', `${M}/ad-metrics/import`, body), b = await p.req('marketer', 'POST', `${M}/ad-metrics/import`, body);
    p.check('first import stores the period', a.body.data?.imported === 1, a.body.data);
    p.check('re-import is idempotent', b.body.data?.imported === 0 && b.body.data?.duplicates === 1, b.body.data);
    p.check('one metric row persisted', (await p.q(db => db.marketingAdMetricImport.count({ where: { connectionId: conn.body.data?.id } }))) === 1);
  },
  async '10-ad-platforms-and-repeat-sales::AC03'(p) {
    const { setAdSandboxQuota } = await providers(), { marketingGrowth } = await svc();
    const contact = await m(p).contact('quota-' + randomUUID().slice(0, 6) + '@example.test'), segment = await m(p).segment([contact.id]);
    const conn = await p.req('marketer', 'POST', `${M}/ad-connections`, { platform: 'META', credentialSecretRef: 'env:META_ADS_TOKEN', externalAccountId: 'act-3', sandbox: true });
    const audience = await p.req('marketer', 'POST', `${M}/ad-audiences`, { connectionId: conn.body.data?.id, segmentId: segment.id });
    setAdSandboxQuota(conn.body.data?.id, 1);
    const job = await p.req('marketer', 'POST', `${M}/ad-audiences/${audience.body.data?.id}/sync`, {});
    await p.call(() => marketingGrowth.tickAdSync(10));
    const partial = await p.q(db => db.marketingAdSyncJob.findUniqueOrThrow({ where: { id: job.body.data?.id } }));
    p.check('quota error yields a partial job with retry', partial.status === 'PARTIAL' && partial.errorCode === 'PROVIDER_QUOTA', partial);
    await p.q(db => db.marketingAdSyncJob.update({ where: { id: partial.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } }));
    await p.call(() => marketingGrowth.tickAdSync(10));
    p.check('retry completes the sync', (await p.q(db => db.marketingAdSyncJob.findUniqueOrThrow({ where: { id: partial.id } }))).status === 'COMPLETED');
  },
};
