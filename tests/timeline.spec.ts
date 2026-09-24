import type { RealtimeHint } from '@/src/server/realtime';
import { ACTIVITY_BASIC, addMember, CRM_READ, DAY, expectAppError, fullApp, HOUR, iso, otherTenant, project } from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const followUp = (t: App, extra: Record<string, unknown> = {}, user = t.user) =>
  t.app.activities.create(user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Check in', ...extra });
const entriesFor = (t: App, entityId: string) => t.app.store.state.crmTimelineEntries.filter((entry) => entry.entityId === entityId);
const read = (t: App, entityType: string, entityId: string, params: Record<string, string> = {}, user = t.user) =>
  t.app.timeline.getTimeline(user, t.workspace.id, entityType, entityId, new URLSearchParams(params));
const stored = (t: App, id: string) => t.app.store.state.crmActivities.find((item) => item.id === id)!;
/** Spreads outbox event times apart so ordering assertions do not depend on millisecond timing. */
const spaceEvents = (t: App) => t.app.store.state.outboxEvents.forEach((event, index) => (event.occurredAt = new Date(Date.UTC(2027, 0, 1) + index * 1000)));

describe('Timeline - projection, ordering and comments', () => {
  it('projects meaningful Activity events with a small sanitized presentation snapshot', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Timeline lead' });
    const a = await t.app.activities.create(t.user, t.workspace.id, {
      typeCode: 'CALL',
      subject: 'Follow up on proposal',
      description: 'Very long confidential internal description that must not be copied into the timeline',
      bindings: [{ entityType: 'LEAD', entityId: lead.id }],
      startAt: iso(2 * DAY),
    });
    await t.app.activities.complete(t.user, t.workspace.id, a.id, { resultText: 'Customer requested revised pricing', customFields: {} });
    project(t.app);
    const entries = entriesFor(t, lead.id).filter((entry) => entry.sourceType === 'ACTIVITY');
    expect(entries.map((entry) => entry.summaryCode)).toEqual(['ACTIVITY_CREATED', 'ACTIVITY_COMPLETED']);
    const completed = entries[1];
    expect(completed).toMatchObject({ category: 'ACTIVITY', sourceId: a.id, entityType: 'LEAD', actorType: 'USER', actorUserId: t.user.id, projectionVersion: 1 });
    expect(completed.presentationSnapshot).toMatchObject({ activityType: 'CALL', subject: 'Follow up on proposal', resultSummary: 'Customer requested revised pricing', activityId: a.id });
    // Small display snapshot only: never the whole source object.
    expect(JSON.stringify(entries)).not.toMatch(/confidential|description/);
    expect(Object.keys(completed.presentationSnapshot).length).toBeLessThanOrEqual(8);
    expect(completed.actorDisplaySnapshot).toBe(`${t.user.firstName} ${t.user.lastName}`);
  });

  it('does not project every technical/minor mutation by default', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Quiet lead' });
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }], deadline: iso(DAY), reminders: [{ mode: 'ABSOLUTE', absoluteAt: iso(HOUR) }] });
    project(t.app);
    const baseline = entriesFor(t, lead.id).length;
    // Minor edits, custom-field/schema changes, reminders, overdue sweeps and binding tweaks stay in Audit/events only.
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, subject: 'Renamed', description: 'tweak', priority: 'HIGH' });
    t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'LEAD', label: 'Noise', fieldType: 'TEXT' });
    t.app.activities.runDueReminders(new Date(Date.now() + 2 * HOUR));
    t.app.activities.runOverdueSweep(new Date(Date.now() + 5 * DAY));
    project(t.app);
    expect(entriesFor(t, lead.id)).toHaveLength(baseline);
    // A genuine reschedule IS timeline-worthy, and so are lifecycle changes.
    await t.app.activities.update(t.user, t.workspace.id, a.id, { expectedVersion: stored(t, a.id).version, deadline: iso(3 * DAY) });
    await t.app.activities.cancel(t.user, t.workspace.id, a.id);
    await t.app.activities.reopen(t.user, t.workspace.id, a.id);
    project(t.app);
    expect(entriesFor(t, lead.id).slice(baseline).map((entry) => entry.summaryCode)).toEqual(['ACTIVITY_RESCHEDULED', 'ACTIVITY_CANCELLED', 'ACTIVITY_REOPENED']);
    // The projector never consumes its own output (no feedback loop).
    const count = t.app.store.state.crmTimelineEntries.length;
    expect(project(t.app)).toEqual({ projected: 0, scanned: 0 });
    expect(t.app.store.state.crmTimelineEntries).toHaveLength(count);
  });

  it('projects CRM stage changes, creation and responsibility changes from the outbox', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', CRM_READ);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Pipeline lead' });
    const qualified = t.app.store.state.crmStages.find((stage) => stage.pipelineId === lead.pipelineId && stage.name === 'Qualified')!;
    t.app.crm.transitionLead(t.user, t.workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: qualified.id });
    t.app.crmCore.assignRecord(t.user, t.workspace.id, 'LEAD', lead.id, { responsibleUserId: mate.user.id, expectedVersion: lead.version });
    spaceEvents(t);
    project(t.app);
    const entries = read(t, 'LEAD', lead.id).data as any[];
    expect(entries.map((entry) => entry.summaryCode)).toEqual(['RESPONSIBLE_CHANGED', 'STAGE_CHANGED', 'CRM_RECORD_CREATED']); // newest first
    const stage = entries.find((entry) => entry.summaryCode === 'STAGE_CHANGED');
    expect(stage).toMatchObject({ category: 'STAGE_CHANGE', presentationSnapshot: { fromStage: { name: 'New' }, toStage: { name: 'Qualified' } } });
    expect(entries.find((entry) => entry.summaryCode === 'RESPONSIBLE_CHANGED').presentationSnapshot.toDisplayName).toContain(mate.user.firstName);
  });

  it('deduplicates repeated source events using a stable source event key', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Dedupe lead' });
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    project(t.app);
    const before = entriesFor(t, lead.id).length;
    // Simulate the outbox delivering every event a second (and third) time.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const event of t.app.store.state.outboxEvents) event.projectedAt = null;
      project(t.app);
    }
    expect(entriesFor(t, lead.id)).toHaveLength(before);
    expect(new Set(entriesFor(t, lead.id).map((entry) => entry.sourceEventId)).size).toBe(before);
    expect(a.id).toBeTruthy();
    // The database-level dedupe key is (workspace, entity, source event, kind).
    const keys = t.app.store.state.crmTimelineEntries.map((entry) => [entry.workspaceId, entry.entityType, entry.entityId, entry.sourceEventId, entry.projectionKind].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('projects one multi-bound Activity event into each intended CRM target exactly once', async () => {
    const t = await fullApp();
    const company = t.app.crmCore.createCompany(t.user, t.workspace.id, { name: 'Acme' });
    const contact = t.app.crmCore.createContact(t.user, t.workspace.id, { firstName: 'N', lastName: 'S' });
    const deal = t.app.crm.createDeal(t.user, t.workspace.id, { title: 'D', companyId: company.id });
    const a = await followUp(t, { bindings: [{ entityType: 'DEAL', entityId: deal.id }, { entityType: 'CONTACT', entityId: contact.id }, { entityType: 'COMPANY', entityId: company.id }] });
    project(t.app);
    for (const event of t.app.store.state.outboxEvents) event.projectedAt = null;
    project(t.app);
    const activityEntries = t.app.store.state.crmTimelineEntries.filter((entry) => entry.sourceId === a.id);
    expect(activityEntries.map((entry) => entry.entityType).sort()).toEqual(['COMPANY', 'CONTACT', 'DEAL']);
    // They share one source event identity and correlation, but each has its own target.
    expect(new Set(activityEntries.map((entry) => entry.sourceEventId)).size).toBe(1);
    // Unbound Activities produce no CRM timeline entry at all.
    const unbound = await followUp(t);
    project(t.app);
    expect(t.app.store.state.crmTimelineEntries.filter((entry) => entry.sourceId === unbound.id)).toHaveLength(0);
  });

  it('orders by occurredAt plus a stable tie-breaker and paginates without gaps or repeats', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Ordered lead' });
    for (let i = 0; i < 7; i += 1) await followUp(t, { subject: `n${i}`, bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    project(t.app);
    const entries = entriesFor(t, lead.id);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    // Force several entries onto the SAME instant: only the tie-breaker can order them.
    const sameInstant = new Date('2027-01-01T00:00:00.000Z');
    entries.slice(0, 5).forEach((entry) => (entry.occurredAt = sameInstant));
    entries.slice(5).forEach((entry, index) => (entry.occurredAt = new Date(sameInstant.getTime() + (index + 1) * 1000)));
    for (const limit of [1, 2, 3, 100]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = read(t, 'LEAD', lead.id, { limit: String(limit), ...(cursor ? { cursor } : {}) });
        seen.push(...(page.data as any[]).map((item) => item.id));
        cursor = page.meta.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(entries.length);
      expect(new Set(seen).size).toBe(entries.length);
    }
    const all = (read(t, 'LEAD', lead.id, { limit: '100' }).data as any[]);
    const times = all.map((item) => new Date(item.occurredAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x)); // newest first, deterministic
    // The same query always yields the same order.
    expect((read(t, 'LEAD', lead.id, { limit: '100' }).data as any[]).map((item) => item.id)).toEqual(all.map((item) => item.id));
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, { cursor: '###' })), 'CRM_CURSOR_INVALID', 400);
  });

  it('filters by category/actor/date/source type using allow-listed query fields', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', [...ACTIVITY_BASIC, ...CRM_READ, ['crm.lead.update', 'WORKSPACE']]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Filter lead' });
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    await t.app.timeline.createComment(mate.user, t.workspace.id, 'LEAD', lead.id, { body: 'A note from the mate' });
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    project(t.app);
    const codes = (params: Record<string, string>) => (read(t, 'LEAD', lead.id, params).data as any[]).map((item) => item.summaryCode ?? 'COMMENT');
    expect(codes({ category: 'COMMENT' })).toEqual(['COMMENT']);
    expect(codes({ category: 'ACTIVITY' }).sort()).toEqual(['ACTIVITY_COMPLETED', 'ACTIVITY_CREATED']);
    expect(codes({ category: 'ACTIVITY,COMMENT' })).toHaveLength(3);
    expect(codes({ actorUserId: mate.user.id })).toEqual(['COMMENT']);
    expect(codes({ sourceType: 'CRM' })).toEqual(['CRM_RECORD_CREATED']);
    expect(codes({ from: iso(HOUR) })).toEqual([]);
    expect(codes({ to: iso(-DAY) })).toEqual([]);
    expect(codes({ from: iso(-DAY), to: iso(DAY) })).toHaveLength(4);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, { category: 'NOT_A_CATEGORY' })), 'CRM_QUERY_INVALID', 400);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, { from: 'yesterday' })), 'CRM_QUERY_INVALID', 400);
  });

  it('keeps the historical projection when a current Activity binding is later removed', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'History lead' });
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    project(t.app);
    const binding = t.app.store.state.crmActivityBindings.find((item) => item.activityId === a.id)!;
    t.app.activities.removeBinding(t.user, t.workspace.id, a.id, binding.id);
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    project(t.app);
    // The past stays truthful; the later completion (no longer bound) is not retro-added to this record.
    expect(entriesFor(t, lead.id).filter((entry) => entry.sourceId === a.id).map((entry) => entry.summaryCode)).toEqual(['ACTIVITY_CREATED']);
  });

  it('applies current authorization at read time and never discloses unreadable sources', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Auth lead' });
    const other = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Other lead' });
    const reader = await addMember(t.app, t.user, t.workspace.id, 'reader', [['timeline.read', 'WORKSPACE'], ['crm.lead.read', 'WORKSPACE']]);
    const noRecord = await addMember(t.app, t.user, t.workspace.id, 'norecord', [['timeline.read', 'WORKSPACE']]);
    const noTimeline = await addMember(t.app, t.user, t.workspace.id, 'notimeline', [['crm.lead.read', 'WORKSPACE']]);
    const foreign = await otherTenant(t.app);
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    project(t.app);

    const asReader = read(t, 'LEAD', lead.id, {}, reader.user).data as any[];
    // The reader can read the record but not the Activity (no activity.read): the entry shows, the link does not.
    const created = asReader.find((entry) => entry.summaryCode === 'ACTIVITY_CREATED');
    expect(created.sourceLink).toBeNull();
    expect(created.presentationSnapshot.activityId).toBeUndefined();
    expect((read(t, 'LEAD', lead.id).data as any[]).find((entry) => entry.summaryCode === 'ACTIVITY_CREATED').sourceLink).toEqual({ type: 'ACTIVITY', id: a.id });

    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, {}, noRecord.user)), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, {}, noTimeline.user)), 'PERMISSION_DENIED', 403);
    // Foreign workspace: the id exists elsewhere but is indistinguishable from any other unreadable record.
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.getTimeline(foreign.user, foreign.workspace.id, 'LEAD', lead.id, new URLSearchParams())), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', '00000000-0000-4000-8000-000000000000')), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'ROBOT', lead.id)), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    // Permission changes take effect immediately: there is no cached access.
    const role = reader.role;
    t.app.roles.replacePermissions(t.user, t.workspace.id, role.id, [{ permissionId: 'timeline.read', scope: 'WORKSPACE' }]);
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, {}, reader.user)), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    expect(other.id).toBeTruthy();
  });

  it('creates/edits/soft-deletes comments with files and mentions', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'sara', [...ACTIVITY_BASIC, ...CRM_READ]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Comment lead' });
    t.files.register(t.workspace.id, '88888888-8888-4888-8888-888888888888');
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    const created = (await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, {
      body: 'Customer confirmed the revised scope. @Sara <script>alert(1)</script>',
      linkedActivityId: a.id,
      fileIds: ['88888888-8888-4888-8888-888888888888'],
      mentions: [{ userId: mate.user.id }, { userId: mate.user.id }],
    })) as any;
    // Plain text only: markup is stripped, mentions are stable user ids (no free-text parsing).
    expect(created.body).toBe('Customer confirmed the revised scope. @Sara alert(1)');
    expect(created.mentions).toEqual([{ userId: mate.user.id }]);
    expect(created).toMatchObject({ linkedActivityId: a.id, fileIds: ['88888888-8888-4888-8888-888888888888'], version: 1, isDeleted: false, authorUserId: t.user.id });
    expect(t.app.store.state.crmTimelineCommentMentions).toHaveLength(1);
    const mentioned = t.app.store.state.outboxEvents.filter((event) => event.eventType === 'TIMELINE_COMMENT_MENTIONED');
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0].payload).toMatchObject({ mentionedUserId: mate.user.id, canAccessRecord: true });

    const edited = t.app.timeline.updateComment(t.user, t.workspace.id, created.id, { expectedVersion: 1, body: 'Edited body', mentions: [] }) as any;
    expect(edited).toMatchObject({ body: 'Edited body', version: 2, edited: true, mentions: [] });
    expect(() => t.app.timeline.updateComment(t.user, t.workspace.id, created.id, { expectedVersion: 1, body: 'stale' })).toThrow(/changed after you loaded/);
    expect(() => t.app.timeline.updateComment(t.user, t.workspace.id, created.id, { body: 'no version' })).toThrow(/expectedVersion/);

    const deleted = t.app.timeline.deleteComment(t.user, t.workspace.id, created.id) as any;
    // A tombstone, not the removed content.
    expect(deleted).toMatchObject({ isDeleted: true, body: null, fileIds: [], mentions: [] });
    const row = t.app.store.state.crmTimelineComments.find((item) => item.id === created.id)!;
    expect(row).toMatchObject({ isDeleted: true, deletedByUserId: t.user.id });
    expect(row.body).toBe('Edited body'); // retained in storage; audited; never returned
    expect(JSON.stringify(read(t, 'LEAD', lead.id).data)).not.toContain('Edited body');
    expect(t.app.store.state.auditLogs.map((log) => log.action)).toEqual(expect.arrayContaining(['TIMELINE.COMMENT_CREATED', 'TIMELINE.COMMENT_UPDATED', 'TIMELINE.COMMENT_DELETED']));
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.updateComment(t.user, t.workspace.id, created.id, { expectedVersion: row.version, body: 'zombie' })), 'TIMELINE_COMMENT_NOT_FOUND', 404);
    // Deleting again is a harmless no-op.
    expect((t.app.timeline.deleteComment(t.user, t.workspace.id, created.id) as any).isDeleted).toBe(true);
    // Invalid input.
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: '   <b></b> ' }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'x', fileIds: ['99999999-9999-4999-8999-999999999999'] }), 'FIELD_REFERENCE_INVALID', 400);
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'x', mentions: [{ userId: '00000000-0000-4000-8000-000000000000' }] }), 'TIMELINE_MENTION_INVALID', 400);
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'x', linkedActivityId: '00000000-0000-4000-8000-000000000000' }), 'TIMELINE_LINKED_ACTIVITY_INVALID', 400);
  });

  it('enforces comment permissions and ownership scopes', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Permission lead' });
    const author = await addMember(t.app, t.user, t.workspace.id, 'author', [...CRM_READ, ['timeline.read', 'WORKSPACE'], ['timeline.comment', 'WORKSPACE'], ['timeline.comment_edit', 'OWN'], ['timeline.comment_delete', 'OWN']]);
    const peer = await addMember(t.app, t.user, t.workspace.id, 'peer', [...CRM_READ, ['timeline.read', 'WORKSPACE'], ['timeline.comment', 'WORKSPACE'], ['timeline.comment_edit', 'OWN'], ['timeline.comment_delete', 'OWN']]);
    const viewer = await addMember(t.app, t.user, t.workspace.id, 'viewer', [...CRM_READ, ['timeline.read', 'WORKSPACE']]);
    const comment = (await t.app.timeline.createComment(author.user, t.workspace.id, 'LEAD', lead.id, { body: 'mine' })) as any;
    await expectAppError(() => t.app.timeline.createComment(viewer.user, t.workspace.id, 'LEAD', lead.id, { body: 'x' }), 'PERMISSION_DENIED', 403);
    // Only the author edits/deletes under OWN scope; a workspace-scoped manager may edit anyone's.
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.updateComment(peer.user, t.workspace.id, comment.id, { expectedVersion: 1, body: 'hijack' })), 'TIMELINE_COMMENT_EDIT_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.deleteComment(peer.user, t.workspace.id, comment.id)), 'TIMELINE_COMMENT_DELETE_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.updateComment(viewer.user, t.workspace.id, comment.id, { expectedVersion: 1, body: 'x' })), 'TIMELINE_COMMENT_EDIT_FORBIDDEN', 403);
    expect((t.app.timeline.updateComment(author.user, t.workspace.id, comment.id, { expectedVersion: 1, body: 'mine, edited' }) as any).body).toBe('mine, edited');
    expect((t.app.timeline.updateComment(t.user, t.workspace.id, comment.id, { expectedVersion: 2, body: 'moderated' }) as any).version).toBe(3);
    // Losing CRM access to the record also removes access to its comments.
    const noAccess = await addMember(t.app, t.user, t.workspace.id, 'stranger', [['timeline.read', 'WORKSPACE'], ['timeline.comment_edit', 'WORKSPACE']]);
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.getComment(noAccess.user, t.workspace.id, comment.id)), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.updateComment(noAccess.user, t.workspace.id, comment.id, { expectedVersion: 3, body: 'x' })), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    // Foreign workspaces cannot reach the comment by id.
    const foreign = await otherTenant(t.app);
    await expectAppError(() => Promise.resolve().then(() => t.app.timeline.getComment(foreign.user, foreign.workspace.id, comment.id)), 'TIMELINE_COMMENT_NOT_FOUND', 404);
  });

  it('replays a comment create with the same idempotency key and refuses a different request', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Idem lead' });
    const first = (await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'once', idempotencyKey: 'c1' })) as any;
    const again = (await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'once', idempotencyKey: 'c1' })) as any;
    expect(again.id).toBe(first.id);
    expect(t.app.store.state.crmTimelineComments).toHaveLength(1);
    expect(t.app.store.state.outboxEvents.filter((event) => event.eventType === 'TIMELINE_COMMENT_CREATED')).toHaveLength(1);
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'different', idempotencyKey: 'c1' }), 'IDEMPOTENCY_CONFLICT', 409);
  });

  it('does not grant CRM access to a mentioned user', async () => {
    const t = await fullApp();
    const outsider = await addMember(t.app, t.user, t.workspace.id, 'outsider', [['timeline.read', 'WORKSPACE'], ['timeline.comment', 'WORKSPACE']]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Private lead' });
    await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'FYI @outsider', mentions: [{ userId: outsider.user.id }] });
    const mention = t.app.store.state.outboxEvents.find((event) => event.eventType === 'TIMELINE_COMMENT_MENTIONED')!;
    // The notification consumer is told the user cannot open the record, so it can degrade the message.
    expect(mention.payload).toMatchObject({ mentionedUserId: outsider.user.id, canAccessRecord: false });
    expect(JSON.stringify(mention.payload)).not.toMatch(/Private lead|FYI/);
    // Nothing about access changed.
    await expectAppError(() => Promise.resolve().then(() => read(t, 'LEAD', lead.id, {}, outsider.user)), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    await expectAppError(() => t.app.timeline.createComment(outsider.user, t.workspace.id, 'LEAD', lead.id, { body: 'can I?' }), 'TIMELINE_ACCESS_FORBIDDEN', 403);
    expect(t.app.crmCore.canReadRecord(outsider.user, t.workspace.id, 'LEAD', lead.id)).toBe(false);
    expect(t.app.store.state.crmRecordObservers).toHaveLength(0);
    // Mentioning someone outside the workspace is refused.
    const foreign = await otherTenant(t.app);
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'x', mentions: [{ userId: foreign.user.id }] }), 'TIMELINE_MENTION_INVALID', 400);
  });

  it('rebuilds projected entries idempotently without deleting user comments', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Rebuild lead' });
    const a = await followUp(t, { bindings: [{ entityType: 'LEAD', entityId: lead.id }] });
    await t.app.activities.complete(t.user, t.workspace.id, a.id);
    await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'human words' });
    project(t.app);
    const snapshot = () => entriesFor(t, lead.id).map((entry) => `${entry.sourceEventId}|${entry.summaryCode}|${entry.occurredAt.toISOString()}`).sort();
    const before = snapshot();
    expect(before.length).toBeGreaterThanOrEqual(3);

    const result = t.app.timeline.rebuild(t.workspace.id);
    expect(result.deleted).toBe(before.length);
    expect(result.reprojected).toBe(before.length);
    expect(snapshot()).toEqual(before);
    t.app.timeline.rebuild(t.workspace.id);
    expect(snapshot()).toEqual(before); // idempotent
    expect(t.app.store.state.crmTimelineComments).toHaveLength(1);
    expect((read(t, 'LEAD', lead.id).data as any[]).filter((item) => item.kind === 'COMMENT')).toHaveLength(1);

    // Scoped rebuilds only touch their scope.
    const other = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Untouched' });
    project(t.app);
    const untouched = entriesFor(t, other.id).map((entry) => entry.id);
    t.app.timeline.rebuild(t.workspace.id, { entityType: 'LEAD', entityId: lead.id });
    expect(entriesFor(t, other.id).map((entry) => entry.id)).toEqual(untouched);
    // Entries whose source event no longer exists cannot be regenerated, so they are kept.
    const orphanSource = t.app.store.state.outboxEvents.find((event) => event.entityId === lead.id && event.eventType === 'CRM.LEAD.CREATED')!;
    t.app.store.state.outboxEvents = t.app.store.state.outboxEvents.filter((event) => event.id !== orphanSource.id);
    t.app.timeline.rebuild(t.workspace.id);
    expect(entriesFor(t, lead.id).some((entry) => entry.sourceEventId === orphanSource.id)).toBe(true);
  });

  it('collapses adjacent noisy entries for display without deleting them', async () => {
    const t = await fullApp();
    const mate = await addMember(t.app, t.user, t.workspace.id, 'mate', CRM_READ);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Grouped lead' });
    for (let i = 0; i < 3; i += 1) {
      t.app.crmCore.assignRecord(t.user, t.workspace.id, 'LEAD', lead.id, { responsibleUserId: i % 2 === 0 ? mate.user.id : t.user.id, expectedVersion: t.app.store.state.crmLeads.find((item) => item.id === lead.id)!.version });
    }
    spaceEvents(t);
    project(t.app);
    const raw = read(t, 'LEAD', lead.id).data as any[];
    const grouped = read(t, 'LEAD', lead.id, { group: 'true' }).data as any[];
    expect(raw.filter((item) => item.summaryCode === 'RESPONSIBLE_CHANGED')).toHaveLength(3);
    const collapsed = grouped.find((item) => item.summaryCode === 'RESPONSIBLE_CHANGED');
    expect(collapsed.collapsedCount).toBe(3);
    expect(collapsed.collapsedIds).toHaveLength(2);
    expect(t.app.store.state.crmTimelineEntries.filter((entry) => entry.summaryCode === 'RESPONSIBLE_CHANGED')).toHaveLength(3);
  });

  it('holds realtime hints until the transaction commits and delivers them only to authorized readers', async () => {
    const t = await fullApp();
    const reader = await addMember(t.app, t.user, t.workspace.id, 'reader', [...CRM_READ, ['timeline.read', 'WORKSPACE']]);
    const blind = await addMember(t.app, t.user, t.workspace.id, 'blind', [['timeline.read', 'WORKSPACE']]);
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Realtime lead' });
    const received: Record<string, RealtimeHint[]> = { reader: [], blind: [], owner: [] };
    t.app.realtime.subscribe({ workspaceId: t.workspace.id, userId: reader.user.id, send: (hint) => received.reader.push(hint) });
    t.app.realtime.subscribe({ workspaceId: t.workspace.id, userId: blind.user.id, send: (hint) => received.blind.push(hint) });
    t.app.realtime.subscribe({ workspaceId: t.workspace.id, userId: t.user.id, send: (hint) => received.owner.push(hint) });
    t.app.realtime.discard();

    await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'hello' });
    // Queued but not yet visible: nothing is announced before the commit.
    expect(t.app.realtime.pendingCount()).toBeGreaterThan(0);
    expect(received.reader).toEqual([]);
    t.app.realtime.flush();
    expect(received.reader.map((hint) => hint.type)).toEqual(['TIMELINE_COMMENT_CREATED']);
    expect(received.owner.map((hint) => hint.type)).toEqual(['TIMELINE_COMMENT_CREATED']);
    expect(received.blind).toEqual([]); // no access to the record => no hint
    expect(Object.keys(received.reader[0].data).sort()).toEqual(['commentId', 'entityId', 'entityType', 'version']); // ids only, never content

    // A failed request announces nothing.
    await expectAppError(() => t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: '' }), 'FIELD_VALIDATION_FAILED');
    t.app.realtime.discard();
    t.app.realtime.flush();
    expect(received.reader).toHaveLength(1);
  });

  it('emits comment and projection events with a stable envelope', async () => {
    const t = await fullApp();
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'Envelope lead' });
    const comment = (await t.app.timeline.createComment(t.user, t.workspace.id, 'LEAD', lead.id, { body: 'hi' })) as any;
    t.app.timeline.updateComment(t.user, t.workspace.id, comment.id, { expectedVersion: 1, body: 'hi again' });
    t.app.timeline.deleteComment(t.user, t.workspace.id, comment.id);
    const types = t.app.store.state.outboxEvents.map((event) => event.eventType);
    expect(types).toEqual(expect.arrayContaining(['TIMELINE_COMMENT_CREATED', 'TIMELINE_COMMENT_UPDATED', 'TIMELINE_COMMENT_DELETED']));
    project(t.app);
    const projected = t.app.store.state.outboxEvents.filter((event) => event.eventType === 'TIMELINE_ENTRY_PROJECTED');
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.every((event) => event.projectedAt)).toBe(true); // informational: never re-consumed
  });
});
