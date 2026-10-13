/**
 * Automation custom extensions, integration credentials, custom trigger ingestion, external calls and SSRF policy
 * (tests/modules/Automation_Products_Catlouge/Automation/automation-security.e2e-spec.ts).
 */
import { EgressError, SafeHttpEgress, assertSafeUrlShape, isPrivateAddress } from '@/src/server/automation/egress';
import type { EgressPort, EgressRequest } from '@/src/server/automation/egress';
import { validateAgainstSchema, validateSchemaDefinition } from '@/src/server/automation/schema';
import { InMemorySecretPort } from '@/src/server/ports';
import { resetRateLimits } from '@/src/server/rate-limit';
import { addMember, expectAppError, fullApp, HOUR, otherTenant } from './support/domain';

const MINUTE = 60_000;
type T = Awaited<ReturnType<typeof setup>>;

async function setup() {
  resetRateLimits();
  const t = await fullApp();
  const { app, user } = t;
  const ws = t.workspace.id;
  const company = app.crmCore.createCompany(user, ws, { name: 'Acme' });
  const deal = app.crm.createDeal(user, ws, { title: 'Big deal', companyId: company.id });
  const A = app.automation;
  const trigger = A.extensions.create(user, ws, {
    kind: 'TRIGGER',
    code: 'carrier_update',
    installationId: 'app-1',
    name: 'Carrier update',
    targetTypes: ['DEAL'],
    payloadSchema: { type: 'object', required: ['carrier'], properties: { carrier: { type: 'string', maxLength: 50 }, weight: { type: 'number', minimum: 0 }, status: { type: 'string', enum: ['SHIPPED', 'DELIVERED'] } } },
  });
  const credential = A.extensions.createCredential(user, ws, { installationId: 'app-1', name: 'Carrier app' });
  const invoke = (body: Record<string, unknown>, key = credential.secret, code = 'carrier_update') => A.extensions.invokeCustomTrigger(key, code, body);
  const rule = (input: Record<string, unknown> = {}) =>
    A.rules.create(user, ws, {
      name: 'On carrier update',
      targetType: 'DEAL',
      trigger: { code: 'ext.carrier_update', config: {} },
      actions: [{ actionCode: 'activities.create_activity', config: { typeCode: 'FOLLOW_UP', subject: 'Carrier {{trigger.payload.carrier}} for {{target.title}}' } }],
      ...input,
    });
  const publish = (created: { id: string; version: number }) => A.rules.publish(user, ws, created.id, { version: created.version });
  return { ...t, ws, A, company, deal, trigger, credential, invoke, rule, publish };
}

describe('Extension registry and schema safety', () => {
  it('registers typed extensions with immutable, unique codes and never returns credentials', async () => {
    const t = await setup();
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { kind: 'TRIGGER', code: 'carrier_update', installationId: 'x', name: 'Dup', targetTypes: ['DEAL'] }), 'AUTOMATION_EXTENSION_CODE_CONFLICT', 409);
    await expectAppError(() => t.A.extensions.update(t.user, t.ws, t.trigger.id, { code: 'renamed' }), 'AUTOMATION_EXTENSION_CODE_IMMUTABLE', 400);
    const action = t.A.extensions.create(t.user, t.ws, { kind: 'ACTION', code: 'sync_erp', installationId: 'app-1', name: 'Sync ERP', targetTypes: ['DEAL'], configSchema: { type: 'object', properties: { note: { type: 'string' }, apiToken: { type: 'string', format: 'secret-ref' } } }, handler: { kind: 'HTTP', url: 'https://erp.example.com/hook', secretRef: 'erp-key' } });
    expect(JSON.stringify(action)).not.toMatch(/Bearer|secretHash/);
    expect(action.handler).toEqual({ kind: 'HTTP', url: 'https://erp.example.com/hook', method: 'POST', secretRef: 'erp-key', timeoutMs: undefined });
    const listed = JSON.stringify(t.A.extensions.list(t.user, t.ws));
    expect(listed).not.toContain(t.credential.secret);
    expect(JSON.stringify(t.A.extensions.listCredentials(t.user, t.ws))).not.toContain(t.credential.secret);
    expect(JSON.stringify(t.A.extensions.listCredentials(t.user, t.ws))).not.toContain('secretHash');
  });

  it('rejects unsafe schemas, plaintext secrets and unsafe handler destinations', async () => {
    expect(validateSchemaDefinition({ type: 'object', properties: { x: { type: 'string', pattern: '.*' } } }).map((p) => p.code)).toContain('SCHEMA_KEY_UNSUPPORTED');
    expect(validateSchemaDefinition({ type: 'object', properties: { apiToken: { type: 'string' } } }).map((p) => p.code)).toContain('SCHEMA_SECRET_MUST_BE_REFERENCE');
    expect(validateSchemaDefinition({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'string' } } } } } } } } } } }).map((p) => p.code)).toContain('SCHEMA_TOO_DEEP');
    expect(validateAgainstSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 1 } } }, { n: 0, extra: true }).map((p) => p.code).sort()).toEqual(['TOO_SMALL', 'UNKNOWN_PROPERTY']);
    const t = await setup();
    const base = { kind: 'ACTION', installationId: 'app-1', name: 'x', targetTypes: ['DEAL'] };
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { ...base, code: 'bad_http', handler: { kind: 'HTTP', url: 'http://example.com/x' } }), 'AUTOMATION_EGRESS_BLOCKED', 400);
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { ...base, code: 'bad_ip', handler: { kind: 'HTTP', url: 'https://169.254.169.254/latest/meta-data' } }), 'AUTOMATION_EGRESS_BLOCKED', 400);
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { ...base, code: 'bad_tok', handler: { kind: 'HTTP', url: 'https://example.com/x', token: 'plaintext' } }), 'AUTOMATION_EXTENSION_INVALID', 400);
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { ...base, code: 'bad_secret', handler: { kind: 'HTTP', url: 'https://example.com/x', secretRef: 'has spaces!' } }), 'AUTOMATION_SECRET_MUST_BE_REFERENCE', 400);
    await expectAppError(() => t.A.extensions.create(t.user, t.ws, { ...base, code: 'bad_target', targetTypes: ['NOPE'], handler: { kind: 'REGISTERED', handlerCode: 'noop_handler' } }), 'AUTOMATION_EXTENSION_INVALID', 400);
  });

  it('requires the manage_extensions capability, stronger than editing a draft', async () => {
    const t = await setup();
    const editor = await addMember(t.app, t.user, t.ws, 'editor', [['automation.manage', 'WORKSPACE'], ['automation.publish', 'WORKSPACE']]);
    await expectAppError(() => t.A.extensions.create(editor.user, t.ws, { kind: 'TRIGGER', code: 'nope_trig', installationId: 'a', name: 'n', targetTypes: ['DEAL'] }), 'PERMISSION_DENIED', 403);
    await expectAppError(() => t.A.extensions.createCredential(editor.user, t.ws, { installationId: 'a', name: 'n' }), 'PERMISSION_DENIED', 403);
  });
});

describe('Custom trigger ingestion', () => {
  it('validates the typed payload, exposes it read-only to Rule evaluation and templates, and runs the Rule', async () => {
    const t = await setup();
    const rule = t.publish(t.rule({ conditions: { type: 'CONDITION', field: 'trigger.payload.status', operator: 'EQ', value: 'SHIPPED' } }));
    expect(rule.state).toBe('ACTIVE');
    const result = t.invoke({ targetId: t.deal.id, eventId: 'evt-1', payload: { carrier: 'DHL', weight: 2.5, status: 'SHIPPED' } });
    expect(result).toMatchObject({ accepted: true, matchedRules: 1, jobsCreated: 1, duplicate: false });
    await t.A.runner.runDue();
    const [activity] = t.app.store.state.crmActivities;
    expect(activity.subject).toBe('Carrier DHL for Big deal');
    const execution = t.app.store.state.automationExecutions[0];
    expect(execution).toMatchObject({ status: 'SUCCEEDED', triggerCode: 'ext.carrier_update', initiatorType: 'SERVICE' });
    // The payload never wrote anything by itself: the Deal is untouched apart from what actions did through services.
    expect(t.app.store.state.crmDeals.find((deal) => deal.id === t.deal.id)!.title).toBe('Big deal');

    const noMatch = t.invoke({ targetId: t.deal.id, eventId: 'evt-2', payload: { carrier: 'UPS', status: 'DELIVERED' } });
    expect(noMatch.jobsCreated).toBe(0);
    expect(t.app.store.state.automationExecutions.some((run) => run.status === 'SKIPPED_CONDITION')).toBe(true);
  });

  it('rejects payloads that violate the schema, unknown keys and caller-chosen tenants', async () => {
    const t = await setup();
    t.publish(t.rule());
    const problems = (await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'DHL', weight: -1, bogus: 1, status: 'LOST' } }), 'AUTOMATION_TRIGGER_PAYLOAD_INVALID', 400)).details.errors.map((p: { code: string }) => p.code).sort();
    expect(problems).toEqual(['NOT_IN_ENUM', 'TOO_SMALL', 'UNKNOWN_PROPERTY']);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { status: 'SHIPPED' } }), 'AUTOMATION_TRIGGER_PAYLOAD_INVALID', 400);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, payload: { carrier: 'x' } }), 'AUTOMATION_TRIGGER_PAYLOAD_INVALID', 400);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', workspaceId: 'someone-else', payload: { carrier: 'x' } }), 'AUTOMATION_TRIGGER_PAYLOAD_INVALID', 400);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }, t.credential.secret, 'unknown_trigger'), 'AUTOMATION_TRIGGER_NOT_SUPPORTED', 404);
    expect(t.app.store.state.automationJobs).toHaveLength(0);
  });

  it('authenticates the integration, resolves the tenant from the credential and rejects foreign targets', async () => {
    const t = await setup();
    t.publish(t.rule());
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }, ''), 'UNAUTHENTICATED', 401);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }, `${t.credential.id}.wrong-secret`), 'UNAUTHENTICATED', 401);
    // A valid credential of another tenant never reaches this tenant's Rules or records.
    const other = await otherTenant(t.app);
    t.A.extensions.create(other.user, other.workspace.id, { kind: 'TRIGGER', code: 'carrier_update', installationId: 'app-1', name: 'Theirs', targetTypes: ['DEAL'], payloadSchema: { type: 'object', properties: { carrier: { type: 'string' } } } });
    const otherCredential = t.A.extensions.createCredential(other.user, other.workspace.id, { installationId: 'app-1', name: 'Theirs' });
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }, otherCredential.secret), 'AUTOMATION_TARGET_NOT_FOUND', 404);
    // Credentials are bound to their installation and to specific trigger codes.
    const wrongInstall = t.A.extensions.createCredential(t.user, t.ws, { installationId: 'another-app', name: 'wrong' });
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }, wrongInstall.secret), 'PERMISSION_DENIED', 403);
    t.A.extensions.revokeCredential(t.user, t.ws, t.credential.id);
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e', payload: { carrier: 'x' } }), 'UNAUTHENTICATED', 401);
  });

  it('deduplicates provider events and rate limits ingestion per credential', async () => {
    const t = await setup();
    t.publish(t.rule());
    const body = { targetId: t.deal.id, eventId: 'same-event', payload: { carrier: 'DHL' } };
    expect(t.invoke(body).jobsCreated).toBe(1);
    expect(t.invoke(body)).toMatchObject({ jobsCreated: 0, duplicate: true });
    await t.A.runner.runDue();
    expect(t.app.store.state.crmActivities).toHaveLength(1);
    for (let i = 0; i < 298; i += 1) t.invoke({ targetId: t.deal.id, eventId: `e${i}`, payload: { carrier: 'DHL' } });
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'overflow', payload: { carrier: 'DHL' } }), 'RATE_LIMITED', 429);
  });

  it('disabling an extension pauses dependent Rules and makes pending jobs fail safely; history stays readable', async () => {
    const t = await setup();
    const rule = t.publish(t.rule({ timing: { mode: 'DELAY', delayMinutes: 10 } }));
    t.invoke({ targetId: t.deal.id, eventId: 'e1', payload: { carrier: 'DHL' } });
    t.A.extensions.setEnabled(t.user, t.ws, t.trigger.id, false);
    expect(t.A.rules.get(t.user, t.ws, rule.id).state).toBe('PAUSED');
    await expectAppError(() => t.invoke({ targetId: t.deal.id, eventId: 'e2', payload: { carrier: 'DHL' } }), 'AUTOMATION_TRIGGER_NOT_SUPPORTED', 404);
    await t.A.runner.runDue({ now: new Date(Date.now() + HOUR) });
    expect(t.app.store.state.automationExecutions[0]).toMatchObject({ status: 'SKIPPED_STALE', skipReason: 'RULE_PAUSED' });
    await expectAppError(() => t.A.extensions.remove(t.user, t.ws, t.trigger.id), 'AUTOMATION_EXTENSION_IN_USE', 409);
    expect(t.A.execution.listExecutions(t.user, t.ws, new URLSearchParams()).data).toHaveLength(1);
    const draft = t.rule({ name: 'new use' });
    await expectAppError(() => t.publish(draft), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
  });

  it('forces the service identity for integration-driven Rules', async () => {
    const t = await setup();
    const rule = t.rule({ executionPolicy: { identity: 'INITIATING_USER' } });
    await expectAppError(() => t.publish(rule), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
  });
});

describe('Custom actions', () => {
  it('runs a registered handler with scoped inputs only and validates configuration against the schema', async () => {
    const t = await setup();
    const seen: unknown[] = [];
    t.A.extensions.registerHandler('erp_sync', (input) => {
      seen.push(input);
      return { synced: true, token: 'must-be-redacted' };
    });
    t.A.extensions.create(t.user, t.ws, { kind: 'ACTION', code: 'erp', installationId: 'app-1', name: 'ERP sync', targetTypes: ['DEAL'], configSchema: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 20 } } }, handler: { kind: 'REGISTERED', handlerCode: 'erp_sync' } });
    const bad = t.A.rules.create(t.user, t.ws, { name: 'bad', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'ext.erp', config: { note: 'x'.repeat(50), extra: 1 } }] });
    const error = await expectAppError(() => t.A.rules.publish(t.user, t.ws, bad.id, { version: bad.version }), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
    expect(error.details.errors.length).toBeGreaterThanOrEqual(2);
    const good = t.A.rules.create(t.user, t.ws, { name: 'good', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'ext.erp', config: { note: '{{target.title}}' } }] });
    t.A.rules.publish(t.user, t.ws, good.id, { version: good.version });
    t.A.execution.executeManually(t.user, t.ws, good.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(['config', 'extensionCode', 'idempotencyKey', 'identityUserId', 'target', 'workspaceId']);
    expect((seen[0] as { config: unknown }).config).toEqual({ note: 'Big deal' });
    const row = t.app.store.state.automationActionExecutions[0];
    expect(row.status).toBe('SUCCEEDED');
    expect(JSON.stringify(row.result)).not.toContain('must-be-redacted');
  });
});

class FakeEgress implements EgressPort {
  requests: EgressRequest[] = [];
  responses: Array<{ status: number } | Error> = [];
  async send(request: EgressRequest) {
    this.requests.push(request);
    const next = this.responses.shift() ?? { status: 200 };
    if (next instanceof Error) throw next;
    return { status: next.status, ok: true, bytes: 12 };
  }
}

async function webhookRule(t: T, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const rule = t.A.rules.create(t.user, t.ws, { name: 'hook', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'integrations.call_webhook', config: { url: 'https://hooks.example.com/deal', secretRef: 'crm-hook', body: { title: '{{target.title}}' }, ...config } }], ...extra });
  return t.A.rules.publish(t.user, t.ws, rule.id, { version: rule.version });
}

describe('Webhook action, secrets and egress policy', () => {
  it('sends with a resolved secret but never persists or logs it, and propagates the action idempotency key', async () => {
    const t = await setup();
    const secrets = new InMemorySecretPort();
    secrets.set(t.ws, 'crm-hook', 'SUPER-SECRET-TOKEN-123');
    t.A.setSecretPort(secrets);
    const egress = new FakeEgress();
    t.A.setEgress(egress);
    const rule = await webhookRule(t);
    t.A.execution.executeManually(t.user, t.ws, rule.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    expect(egress.requests).toHaveLength(1);
    const [request] = egress.requests;
    expect(request).toMatchObject({ url: 'https://hooks.example.com/deal', method: 'POST' });
    expect(request.headers.authorization).toBe('Bearer SUPER-SECRET-TOKEN-123');
    const row = t.app.store.state.automationActionExecutions[0];
    expect(request.headers['idempotency-key']).toBe(row.idempotencyKey);
    expect(JSON.parse(request.body!)).toEqual({ title: 'Big deal' });
    const everything = JSON.stringify([t.app.store.state.automationActionExecutions, t.app.store.state.automationLogs, t.app.store.state.automationExecutions, t.app.store.state.automationRevisions, t.app.store.state.automationActions, t.app.store.state.auditLogs, t.app.store.state.outboxEvents]);
    expect(everything).not.toContain('SUPER-SECRET-TOKEN-123');
    expect(row.result).toEqual({ status: 200, responseBytes: 12 });
    expect(t.app.store.state.automationExecutions[0].status).toBe('SUCCEEDED');
  });

  it('fails permanently when the credential reference cannot be resolved and never reveals why in detail', async () => {
    const t = await setup();
    t.A.setEgress(new FakeEgress());
    const rule = await webhookRule(t);
    t.A.execution.executeManually(t.user, t.ws, rule.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    const row = t.app.store.state.automationActionExecutions[0];
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'AUTOMATION_SECRET_UNAVAILABLE', retryable: false });
    expect(t.app.store.state.automationExecutions[0].status).toBe('FAILED_FINAL');
  });

  it('retries transient network failures with the same idempotency key and stops on 4xx', async () => {
    const t = await setup();
    const secrets = new InMemorySecretPort();
    secrets.set(t.ws, 'crm-hook', 'tok-tok-tok');
    t.A.setSecretPort(secrets);
    const egress = new FakeEgress();
    egress.responses = [new EgressError('AUTOMATION_EGRESS_HTTP_ERROR', 'HTTP 503', true)];
    t.A.setEgress(egress);
    const rule = await webhookRule(t);
    t.A.execution.executeManually(t.user, t.ws, rule.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    expect(t.app.store.state.automationExecutions[0].status).toBe('FAILED_RETRYABLE');
    await t.A.runner.runDue({ now: new Date(Date.now() + 10 * MINUTE) });
    expect(t.app.store.state.automationExecutions[0].status).toBe('SUCCEEDED');
    expect(new Set(egress.requests.map((request) => request.headers['idempotency-key'])).size).toBe(1);

    const permanent = new FakeEgress();
    permanent.responses = [new EgressError('AUTOMATION_EGRESS_HTTP_ERROR', 'HTTP 400', false)];
    t.A.setEgress(permanent);
    t.A.execution.executeManually(t.user, t.ws, rule.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    const failed = t.app.store.state.automationExecutions[1];
    expect(failed.status).toBe('FAILED_FINAL');
    expect(permanent.requests).toHaveLength(1);
  });

  it('refuses unsafe destinations at publish time and at call time (SSRF)', async () => {
    const t = await setup();
    for (const url of ['http://hooks.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://user:pass@hooks.example.com/x', 'https://hooks.example.com:9999/x', 'https://metadata.google.internal/x', 'https://intranet/x', 'https://{{target.title}}.example.com/x']) {
      const rule = t.A.rules.create(t.user, t.ws, { name: 'ssrf', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'integrations.call_webhook', config: { url } }] });
      await expectAppError(() => t.A.rules.publish(t.user, t.ws, rule.id, { version: rule.version }), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
    }
    const egress = new SafeHttpEgress({
      fetchImpl: (async (url: string) => {
        if (String(url).includes('redirect.example.com')) return new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } });
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
      resolver: async (host) => (host === 'internal.example.com' || host === 'rebind.example.com' ? ['10.1.2.3'] : ['93.184.216.34']),
    });
    const call = (url: string) => egress.send({ url, method: 'POST', headers: {}, body: '{}', timeoutMs: 2000 });
    await expect(call('https://hooks.example.com/ok')).resolves.toMatchObject({ status: 200 });
    // DNS that resolves to a private address, and a redirect into the private network, are both blocked.
    await expect(call('https://rebind.example.com/x')).rejects.toMatchObject({ code: 'AUTOMATION_EGRESS_BLOCKED' });
    await expect(call('https://redirect.example.com/x')).rejects.toMatchObject({ code: 'AUTOMATION_EGRESS_BLOCKED' });
    await expect(call('http://hooks.example.com/x')).rejects.toMatchObject({ code: 'AUTOMATION_EGRESS_BLOCKED' });
    expect(['10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '127.0.0.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946'].some(isPrivateAddress)).toBe(false);
    expect(() => assertSafeUrlShape('https://hooks.example.com/x', { allowHttp: false })).not.toThrow();
  });

  it('keeps the service execution scoped: an action the identity is not registered for cannot run', async () => {
    const t = await setup();
    const rule = t.A.rules.create(t.user, t.ws, { name: 'sneaky', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'roles.grant_admin', config: {} }] });
    await expectAppError(() => t.A.rules.publish(t.user, t.ws, rule.id, { version: rule.version }), 'AUTOMATION_RULE_NOT_PUBLISHABLE', 400);
    // Even if a stale definition slipped through, the runner refuses an unregistered action code.
    const good = await webhookRule(t, {}, { name: 'legit' });
    const revision = t.app.store.state.automationRevisions.find((item) => item.ruleId === good.id)!;
    const action = t.app.store.state.automationActions.find((item) => item.revisionId === revision.id)!;
    action.actionCode = 'roles.grant_admin';
    t.A.execution.executeManually(t.user, t.ws, good.id, { targetId: t.deal.id });
    await t.A.runner.runDue();
    expect(t.app.store.state.automationExecutions[0]).toMatchObject({ status: 'FAILED_FINAL' });
    expect(t.app.store.state.roles.some((role) => role.name.toLowerCase().includes('admin') && role.workspaceId === t.ws && !role.isOwnerRole)).toBe(false);
  });
});
