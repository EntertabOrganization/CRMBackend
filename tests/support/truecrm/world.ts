import { PrismaClient, type PermissionScope } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prepareProcessPlatformDatabase } from '../process-platform-db';

/**
 * Real TrueCRM contract world: an owned, migrated disposable PostgreSQL database, real permission
 * catalog, real Workspaces/Users/Roles, and in-process dispatch to the same PackRouters that serve
 * Next.js and NestJS. No platform source of truth is faked; only external providers use sandboxes.
 */
export type Actor = 'owner' | 'admin' | 'employee' | 'manager' | 'hr' | 'publisher' | 'marketer' | 'customer' | 'guest' | 'outsider';
export type Fixture = { workspaceId: string; otherWorkspaceId: string; ids: Record<string, string>; tokens: Partial<Record<Actor, string>>; publicHost?: string; metadata?: Record<string, unknown> };
export type Req = { actor: Actor; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: unknown; headers?: Record<string, string> };
export type Res = { status: number; body: { success?: boolean; data?: any; error?: { code?: string; details?: unknown }; requestId?: string; meta?: unknown } };

const DB_NAME = 'truecrm_suite_contract_test';
let ready: Promise<PrismaClient> | null = null;
export function database() {
  ready ??= (async () => {
    await prepareProcessPlatformDatabase(DB_NAME);
    process.env.SITES_PLATFORM_DOMAIN ??= 'sites.contract.test';
    const { prisma } = await import('../../../src/server/prisma-client');
    const name = (await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name;
    if (name !== DB_NAME) throw new Error('Contract harness refused a non-owned database: ' + name);
    return prisma;
  })();
  return ready;
}

const SELF_HR = ['hr.employee.read_self', 'hr.worktime.clock_self', 'hr.attendance.request', 'hr.timesheet.submit_self', 'hr.leave.request_self', 'hr.overtime.request_self', 'hr.workreport.create_self'];
const GRANTS: Record<Exclude<Actor, 'owner' | 'admin' | 'customer' | 'guest' | 'outsider'>, Array<[string, PermissionScope]>> = {
  employee: [...SELF_HR.map(k => [k, 'OWN'] as [string, PermissionScope]), ['sites.site.read', 'WORKSPACE'], ['sites.page.create', 'WORKSPACE'], ['sites.page.edit', 'WORKSPACE'], ['sites.block.edit', 'WORKSPACE'],
    ['marketing.segment.read', 'WORKSPACE'], ['marketing.campaign.read', 'WORKSPACE'], ['COMMERCE.STORE_VIEW', 'WORKSPACE'], ['file.read', 'WORKSPACE']],
  manager: [...SELF_HR.map(k => [k, 'OWN'] as [string, PermissionScope]), ['hr.employee.read_department', 'DEPARTMENT'], ['hr.attendance.approve_team', 'DEPARTMENT'], ['hr.timesheet.approve_team', 'DEPARTMENT'],
    ['hr.leave.approve_team', 'DEPARTMENT'], ['hr.overtime.approve_team', 'DEPARTMENT'], ['hr.workreport.read_team', 'DEPARTMENT'], ['hr.workreport.review_team', 'DEPARTMENT'], ['hr.analytics.read', 'DEPARTMENT'], ['hr.schedule.read', 'WORKSPACE']],
  hr: [],
  publisher: [],
  marketer: [],
};

export type World = Awaited<ReturnType<typeof createWorld>>;
/** Workspace A (all actors) and Workspace B (outsider + foreign resources). */
export async function createWorld(db: PrismaClient) {
  const permissions = await db.permission.findMany({ where: { isDeleted: false } });
  const byKey = new Map(permissions.map(p => [p.key, p.id]));
  const prefixed = (prefixes: string[]) => permissions.filter(p => prefixes.some(x => p.key.startsWith(x))).map(p => [p.key, 'WORKSPACE'] as [string, PermissionScope]);
  GRANTS.hr = [...prefixed(['hr.']), ['file.read', 'WORKSPACE'], ['task.read', 'WORKSPACE'], ['WORKFLOW.START', 'WORKSPACE'], ['WORKFLOW.VIEW', 'WORKSPACE']];
  GRANTS.publisher = [...prefixed(['sites.']), ['file.read', 'WORKSPACE'], ['form.read', 'WORKSPACE'], ['COMMERCE.STORE_VIEW', 'WORKSPACE']];
  GRANTS.marketer = [...prefixed(['marketing.']), ['crm.contact.read', 'WORKSPACE'], ['file.read', 'WORKSPACE'], ['WORKFLOW.START', 'WORKSPACE'], ['WORKFLOW.VIEW', 'WORKSPACE'], ['WORKFLOW.PUBLISH', 'WORKSPACE']];
  const all = permissions.map(p => [p.key, 'WORKSPACE'] as [string, PermissionScope]);
  const user = (label: string) => db.user.create({ data: { firstName: label, lastName: 'Contract', email: `${label}-${randomUUID()}@example.test`, status: 'ACTIVE', emailVerifiedAt: new Date() } });
  const workspace = async (label: string, ownerId: string, settings: object = {}) => db.workspace.create({ data: { name: label, slug: label.toLowerCase() + '-' + randomUUID(), ownerUserId: ownerId, settings } });
  const member = async (workspaceId: string, userId: string, label: string, grants: Array<[string, PermissionScope]>) => {
    const role = await db.role.create({ data: { workspaceId, name: label + ' ' + randomUUID().slice(0, 6) } });
    await db.workspaceMembership.create({ data: { workspaceId, userId, roleId: role.id } });
    const unique = new Map(grants.filter(([k]) => byKey.has(k)));
    await db.rolePermission.createMany({ data: [...unique].map(([key, scope]) => ({ roleId: role.id, permissionId: byKey.get(key)!, scope })) });
    return role;
  };
  const users = Object.fromEntries(await Promise.all((['owner', 'admin', 'employee', 'manager', 'hr', 'publisher', 'marketer', 'outsider', 'approver'] as const).map(async a => [a, await user(a)]))) as Record<Actor | 'approver', { id: string; email: string }>;
  const a = await workspace('A', users.owner.id), b = await workspace('B', users.outsider.id);
  const department = await db.department.create({ data: { workspaceId: a.id, name: 'Operations ' + randomUUID().slice(0, 4), managerId: users.manager.id } });
  const otherDepartment = await db.department.create({ data: { workspaceId: a.id, name: 'Finance ' + randomUUID().slice(0, 4) } });
  for (const actor of ['owner', 'admin', 'approver'] as const) await member(a.id, users[actor].id, actor, all);
  for (const actor of ['employee', 'manager', 'hr', 'publisher', 'marketer'] as const) await member(a.id, users[actor].id, actor, GRANTS[actor]);
  for (const actor of ['employee', 'manager'] as const) await db.departmentMember.create({ data: { workspaceId: a.id, departmentId: department.id, userId: users[actor].id } });
  await member(b.id, users.outsider.id, 'outsider', all);
  const { signAccessToken } = await import('../../../src/server/security');
  const tokens: Partial<Record<Actor, string>> = {};
  for (const actor of ['owner', 'admin', 'employee', 'manager', 'hr', 'publisher', 'marketer', 'outsider'] as const) tokens[actor] = await signAccessToken(users[actor].id);
  const { resolvePrincipal } = await import('../../../src/server/process-platform/context');
  const principal = (actor: Actor | 'approver') => resolvePrincipal(db, actor === 'outsider' ? b.id : a.id, users[actor].id);
  return { db, a, b, users, tokens, department, otherDepartment, principal, approverToken: await signAccessToken(users.approver.id) };
}

type RouterLike = { dispatch(request: import('next/server').NextRequest): Promise<Response> };
let routers: Array<[RegExp, RouterLike]> | null = null;
async function routerFor(path: string) {
  if (!routers) {
    const commerce = await import('../../../src/server/commerce/routes'), marketing = await import('../../../src/server/marketing/routes');
    const hr = await import('../../../src/server/hr/routes'), sites = await import('../../../src/server/sites/routes');
    routers = [
      [/^\/api\/v1\/public\/marketing\/|^\/api\/v1\/integrations\/marketing\//, marketing.marketingPublicRouter],
      [/^\/api\/v1\/public\/(sites|robots\.txt|sitemap\.xml)/, sites.sitesPublicRouter],
      [/^\/api\/v1\/(public|customer)\/|^\/api\/v1\/integrations\/(payments|shipping)\//, commerce.commercePublicRouter],
      [/^\/api\/v1\/(commerce|crm\/contacts)\//, commerce.commerceRouter],
      [/^\/api\/v1\/marketing\//, marketing.marketingRouter],
      [/^\/api\/v1\/hr\//, hr.hrRouter],
      [/^\/api\/v1\/sites(\/|$)/, sites.sitesRouter],
    ];
  }
  const hit = routers.find(([pattern]) => pattern.test(path));
  if (!hit) throw new Error('No TrueCRM router for ' + path);
  return hit[1];
}

/** Sends a real request through the route handler (auth, rate limits, envelopes, error mapping). */
export async function send(world: World, fixture: Fixture, input: Req): Promise<Res> {
  const { NextRequest } = await import('next/server');
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': '203.0.113.' + (Math.floor(Math.random() * 200) + 1) });
  const token = input.actor === 'customer' || input.actor === 'guest' ? fixture.tokens[input.actor] : input.actor === 'outsider' ? world.tokens.outsider : (fixture.tokens[input.actor] ?? world.tokens[input.actor]);
  if (token) headers.set('authorization', 'Bearer ' + token);
  if (!['customer', 'guest'].includes(input.actor)) headers.set('x-workspace-id', input.actor === 'outsider' ? fixture.otherWorkspaceId : fixture.workspaceId);
  if (input.actor === 'guest' && !input.headers?.['x-checkout-token']) {
    // Each guest checkout session carries its own unguessable token; resolve it from the session in the path.
    const sessionId = /\/checkout-sessions\/([0-9a-f-]{36})/.exec(input.path)?.[1];
    const token = (sessionId && (fixture.metadata?.sessionTokens as Record<string, string> | undefined)?.[sessionId]) ?? fixture.metadata?.checkoutToken;
    if (token) headers.set('x-checkout-token', String(token));
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) headers.set(k, v);
  const request = new NextRequest(new URL('http://contract.test' + input.path), { method: input.method, headers, ...(input.method !== 'GET' && input.method !== 'DELETE' || input.body !== undefined ? { body: JSON.stringify(input.body ?? {}) } : {}) });
  const response = await (await routerFor(input.path)).dispatch(request);
  const text = await response.text();
  let body: Res['body'] = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { data: text }; }
  return { status: response.status, body };
}

/** Read-only inspection of persisted truth for the fixture's workspace. */
export async function observe(world: World, fixture: Fixture, collection: string, where: Record<string, unknown> = {}): Promise<any[]> {
  const db = world.db, ws = { workspaceId: fixture.workspaceId };
  const w = where as Record<string, any>;
  switch (collection) {
    case 'orders': {
      const rows = await db.commerceOrder.findMany({ where: { ...ws, ...(w.id ? { id: w.id } : {}) } });
      const deals = await db.commerceCrmBinding.findMany({ where: { ...ws, orderId: { in: rows.map(r => r.id) }, entityType: 'DEAL' } });
      return rows.map(r => ({ ...r, total: r.total.toFixed(6), dealId: deals.find(d => d.orderId === r.id)?.targetId ?? null }));
    }
    case 'inventory_reservations': return (await db.inventoryReservation.findMany({ where: { ...ws, ...(w.variantId ? { inventoryKey: w.variantId } : {}), ...(w.status ? { status: w.status } : {}), ...(w.orderId ? { sourceId: w.orderId } : {}) } })).map(r => ({ ...r, quantity: r.quantity.toFixed(6) }));
    case 'payment_allocations': return db.commerceOrderPaymentBinding.findMany({ where: { ...ws, ...(w.orderId ? { orderId: w.orderId } : {}) } });
    case 'refunds': return db.commerceRefundBinding.findMany({ where: { ...ws, ...(w.orderId ? { orderId: w.orderId } : {}) } });
    case 'marketing_deliveries': return (await db.marketingDelivery.findMany({ where: { ...ws, ...(w.campaignId ? { campaignId: w.campaignId } : {}), ...(w.recipientKey ? { recipientKey: w.recipientKey } : {}) } }))
      .map(d => ({ ...d, idempotencyKey: [d.campaignId, d.recipientKey, d.channel, d.variantId].join(':') }));
    case 'marketing_events': return db.marketingEngagementEvent.findMany({ where: { ...ws, ...(w.campaignId ? { campaignId: w.campaignId } : {}) } });
    case 'suppression_entries': return db.marketingSuppression.findMany({ where: { ...ws, ...(w.destinationHash ? { destinationHash: w.destinationHash } : {}), liftedAt: null } });
    case 'hr_work_events': return db.hrWorkEvent.findMany({ where: { ...ws, ...(w.employeeId ? { employeeId: w.employeeId } : {}), ...(w.sessionId ? { sessionId: w.sessionId } : {}), ...(w.idempotencyKey ? { idempotencyKey: w.idempotencyKey } : {}) } });
    case 'hr_timesheets': return db.hrTimesheet.findMany({ where: { ...ws, ...(w.id ? { id: w.id } : {}), ...(w.employeeId ? { employeeId: w.employeeId } : {}) } });
    case 'hr_leave_ledger': return (await db.hrLeaveLedger.findMany({ where: { ...ws, ...(w.employeeId ? { employeeId: w.employeeId } : {}), ...(w.kind ? { kind: w.kind } : {}), ...(w.active !== undefined ? { active: w.active } : {}) } })).map(r => ({ ...r, units: r.units.toFixed(4) }));
    case 'site_releases': return db.siteRelease.findMany({ where: { ...ws, ...(w.siteId ? { siteId: w.siteId } : {}), ...(w.status ? { status: w.status } : {}), ...(w.id ? { id: w.id } : {}) } });
    case 'site_page_revisions': return db.sitePageRevision.findMany({ where: { ...ws, ...(w.pageId ? { pageId: w.pageId } : {}), ...(w.status ? { status: w.status } : {}) } });
    case 'audit_events': return db.auditLog.findMany({ where: { workspaceId: fixture.workspaceId, ...(w.resourceId ? { entityId: w.resourceId } : {}), ...(w.action ? { action: w.action } : {}) } });
    case 'outbox_events': return db.outboxEvent.findMany({ where: { ...ws, ...(w.resourceId ? { entityId: w.resourceId } : {}), ...(w.eventType ? { eventType: w.eventType } : {}) } });
    case 'provider_calls': return db.suiteProviderCall.findMany({ where: { ...ws, ...(w.campaignId ? { campaignId: w.campaignId } : {}), ...(w.recipientKey ? { recipientKey: w.recipientKey } : {}) } });
    default: throw new Error('Unknown observation ' + collection);
  }
}
