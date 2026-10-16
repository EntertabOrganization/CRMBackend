import { prisma } from '../prisma-client';
import { AppError } from '../errors';
import './register';
import { SuiteRouter } from './http';
import { PlatformEventService, PlatformJobService } from './events-service';
import { PlatformNotificationService } from './notifications-service';
import { PlatformRealtimeService } from './realtime-service';
import { PlatformSearchService } from './search-service';
import { PlatformGovernanceService } from './governance-service';
import { PlatformConfigService } from './config-service';
import { PlatformPrivacyService } from './privacy-service';
import { PlatformOpsService } from './ops-service';

const events = new PlatformEventService(prisma), jobs = new PlatformJobService(prisma), notifications = new PlatformNotificationService(prisma);
const realtime = new PlatformRealtimeService(prisma), search = new PlatformSearchService(prisma), governance = new PlatformGovernanceService(prisma);
const config = new PlatformConfigService(prisma), privacy = new PlatformPrivacyService(prisma), ops = new PlatformOpsService(prisma);
const mfa = (c: { request: { headers: Headers } }) => c.request.headers.get('x-mfa-assertion');
const sameWorkspace = (actorWorkspace: string, id: string) => { if (actorWorkspace !== id) throw new AppError('NOT_FOUND', 'Workspace was not found.', 404); };
const A = '/api/v1/platform/admin';

/** 30-Platform-Services HTTP surface. Platform routes use platform.* grants only; Workspace routes use membership-resolved principals. */
export const platformRouter = new SuiteRouter()
  // 01/02 events, jobs, schedules
  .platform('GET', A + '/events', c => events.list(c.actor, c.query))
  .platform('GET', A + '/events/:id/deliveries', c => events.deliveries(c.actor, c.params.id))
  .platform('POST', A + '/events/:id/replay', c => events.replay(c.actor, c.params.id, c.body, c.requestId), 202)
  .platform('GET', A + '/jobs', c => jobs.list(c.actor, c.query))
  .platform('GET', A + '/jobs/:id/attempts', c => jobs.attempts(c.actor, c.params.id))
  .platform('POST', A + '/jobs/:id/retry', c => jobs.command(c.actor, c.params.id, 'retry', c.body, c.requestId), 202)
  .platform('POST', A + '/jobs/:id/cancel', c => jobs.command(c.actor, c.params.id, 'cancel', c.body, c.requestId))
  .platform('GET', A + '/schedules', c => jobs.schedules(c.actor))
  .platform('PATCH', A + '/schedules/:id', c => jobs.patchSchedule(c.actor, c.params.id, c.body, c.requestId))
  // 03 notifications
  .workspace('POST', '/api/v1/platform/notifications/emit', c => notifications.adminEmit(c.actor, c.body, c.requestId), 202)
  .signed('/api/v1/platform/notifications/providers/:provider/events', c => notifications.providerEvent(c.params.provider, c.request.headers, c.rawBody ?? ''))
  // 04 realtime
  .workspace('POST', '/api/v1/platform/realtime/token', c => realtime.token(c.actor), 201)
  .public('GET', '/api/v1/platform/realtime/poll', async c => { const auth = await realtime.authorize(c.query.token ?? '', c.query.topics ?? ''); return realtime.poll(auth.actor, auth.topics, c.query.cursor ?? null); })
  .workspace('POST', '/api/v1/platform/realtime/presence/heartbeat', async c => realtime.heartbeat(c.actor, String((c.body as { resource?: string }).resource ?? '')))
  .workspace('GET', '/api/v1/platform/realtime/presence', async c => realtime.present(c.actor, c.query.resource ?? ''))
  // 06 audit, security, support access
  .platform('GET', A + '/audit', c => governance.auditQuery(c.actor, c.query))
  .platform('GET', A + '/security-events', c => governance.securityEvents(c.actor, c.query))
  .platform('POST', A + '/support-access', c => governance.requestSupport(c.actor, c.body, c.requestId), 201)
  .platform('POST', A + '/emergency-access', c => governance.emergency(c.actor, c.body, mfa(c), c.requestId), 201)
  .platform('POST', A + '/emergency-access/:id/approve', c => governance.approveEmergency(c.actor, c.params.id, mfa(c), c.requestId))
  .platform('POST', A + '/emergency-access/:id/review', c => governance.reviewEmergency(c.actor, c.params.id, c.body, c.requestId))
  // 07 settings, flags
  .platform('GET', A + '/settings', c => config.globalSettings(c.actor))
  .platform('PATCH', A + '/settings', c => config.patchGlobalSettings(c.actor, c.body, c.requestId))
  .platform('GET', A + '/feature-flags', c => config.flags(c.actor))
  .platform('POST', A + '/feature-flags', c => config.createFlag(c.actor, c.body, c.requestId), 201)
  .platform('PATCH', A + '/feature-flags/:id', c => config.patchFlag(c.actor, c.params.id, c.body, c.requestId))
  .public('POST', '/api/v1/internal/numbering/next', c => config.nextNumber(c.request.headers.get('authorization'), c.body))
  // 08 rate limits, idempotency, caches
  .platform('GET', A + '/rate-limits', c => governance.rateLimits(c.actor))
  .platform('PUT', A + '/rate-limits', c => governance.setRateLimit(c.actor, c.body, c.requestId))
  .platform('GET', A + '/idempotency/:id', c => governance.idempotencyRecord(c.actor, c.params.id))
  .platform('POST', A + '/cache/invalidate', c => governance.invalidateCache(c.actor, c.body, c.requestId))
  // 09 retention
  .platform('GET', '/api/v1/platform/retention/policies', c => privacy.policies(c.actor, c.query))
  .platform('POST', '/api/v1/platform/retention/policies', c => privacy.createPolicy(c.actor, c.body, c.requestId), 201)
  .platform('PATCH', '/api/v1/platform/retention/policies/:id', c => privacy.patchPolicy(c.actor, c.params.id, c.body, c.requestId))
  // 10 ops
  .platform('GET', A + '/ops/metrics', c => ops.metrics(c.actor))
  .platform('GET', A + '/ops/alert-rules', c => ops.alertRules(c.actor))
  .platform('PUT', A + '/ops/alert-rules', c => ops.upsertAlertRule(c.actor, c.body, c.requestId))
  .platform('GET', A + '/ops/alerts', c => ops.alerts(c.actor, c.query))
  .platform('POST', A + '/ops/alerts/:id/acknowledge', c => ops.alertCommand(c.actor, c.params.id, 'acknowledge', c.requestId))
  .platform('POST', A + '/ops/alerts/:id/resolve', c => ops.alertCommand(c.actor, c.params.id, 'resolve', c.requestId))
  .platform('GET', A + '/ops/recovery-plans', c => ops.recoveryPlans(c.actor))
  .platform('PUT', A + '/ops/recovery-plans', c => ops.upsertRecoveryPlan(c.actor, c.body, c.requestId))
  .platform('POST', A + '/ops/restore-tests', c => ops.requestRestoreTest(c.actor, c.body, mfa(c), c.requestId), 202)
  .public('GET', '/api/v1/health/live', async () => PlatformOpsService.live());

/** Current-user surface (`/api/v1/me`): own notifications, devices, recents, favorites and locale only. */
export const meRouter = new SuiteRouter()
  .workspace('GET', '/api/v1/me/notifications', c => notifications.inbox(c.actor, c.query))
  .workspace('POST', '/api/v1/me/notifications/read-all', c => notifications.readAll(c.actor))
  .workspace('POST', '/api/v1/me/notifications/:id/read', c => notifications.mark(c.actor, c.params.id, 'READ'))
  .workspace('POST', '/api/v1/me/notifications/:id/unread', c => notifications.mark(c.actor, c.params.id, 'UNREAD'))
  .workspace('POST', '/api/v1/me/notifications/:id/archive', c => notifications.mark(c.actor, c.params.id, 'ARCHIVED'))
  .workspace('GET', '/api/v1/me/notification-preferences', c => notifications.preferences(c.actor))
  .workspace('PATCH', '/api/v1/me/notification-preferences', c => notifications.updatePreferences(c.actor, c.body))
  .workspace('POST', '/api/v1/me/devices', c => notifications.registerDevice(c.actor, c.body), 201)
  .workspace('DELETE', '/api/v1/me/devices/:id', c => notifications.revokeDevice(c.actor, c.params.id))
  .workspace('GET', '/api/v1/me/recent', c => search.recents(c.actor))
  .workspace('POST', '/api/v1/me/recent', c => search.touchRecent(c.actor, c.body))
  .workspace('GET', '/api/v1/me/favorites', c => search.favorites(c.actor))
  .workspace('PUT', '/api/v1/me/favorites/:type/:id', c => search.favorite(c.actor, c.params.type, c.params.id, true))
  .workspace('DELETE', '/api/v1/me/favorites/:type/:id', c => search.favorite(c.actor, c.params.type, c.params.id, false))
  .workspace('GET', '/api/v1/me/preferences', c => config.myLocale(c.actor))
  .workspace('PATCH', '/api/v1/me/preferences', c => config.setMyLocale(c.actor, c.body));

export const searchRouter = new SuiteRouter()
  .workspace('GET', '/api/v1/search', c => search.search(c.actor, c.query))
  .workspace('POST', '/api/v1/search/reindex', c => search.reindex(c.actor, c.body, c.requestId), 202)
  .workspace('GET', '/api/v1/search/reindex/:id', c => search.reindexStatus(c.actor, c.params.id));

const W = '/api/v1/workspaces/:workspaceId';
/** Workspace-scoped governance: settings, support access approvals, privacy requests, legal holds, readiness. */
export const workspaceGovernanceRouter = new SuiteRouter()
  .workspace('GET', '/api/v1/workspaces/current/settings', c => config.workspaceSettings(c.actor))
  .workspace('PATCH', '/api/v1/workspaces/current/settings', c => config.patchWorkspaceSettings(c.actor, c.body, c.requestId))
  .workspace('GET', W + '/support-access', async c => { sameWorkspace(c.actor.workspaceId, c.params.workspaceId); return governance.supportHistory(c.actor); })
  .workspace('POST', W + '/support-access/:grantId/approve', async c => { sameWorkspace(c.actor.workspaceId, c.params.workspaceId); return governance.decideSupport(c.actor, c.params.grantId, c.body, 'approve', c.requestId); })
  .workspace('POST', W + '/support-access/:grantId/reject', async c => { sameWorkspace(c.actor.workspaceId, c.params.workspaceId); return governance.decideSupport(c.actor, c.params.grantId, c.body, 'reject', c.requestId); })
  .workspace('POST', W + '/support-access/:grantId/revoke', async c => { sameWorkspace(c.actor.workspaceId, c.params.workspaceId); return governance.decideSupport(c.actor, c.params.grantId, c.body, 'revoke', c.requestId); })
  .workspace('POST', W + '/privacy-requests', c => privacy.submit(c.actor, c.params.workspaceId, c.body, c.requestId), 202)
  .workspace('GET', W + '/privacy-requests', c => privacy.list(c.actor, c.params.workspaceId, c.query))
  .workspace('GET', W + '/privacy-requests/:requestId', c => privacy.get(c.actor, c.params.workspaceId, c.params.requestId))
  .workspace('POST', W + '/privacy-requests/:requestId/decision', c => privacy.decide(c.actor, c.params.workspaceId, c.params.requestId, c.body, c.requestId))
  .workspace('GET', W + '/privacy-requests/:requestId/export', c => privacy.download(c.actor, c.params.workspaceId, c.params.requestId, c.requestId))
  .workspace('GET', W + '/legal-holds', c => privacy.holds(c.actor, c.params.workspaceId))
  .workspace('POST', W + '/legal-holds', c => privacy.applyHold(c.actor, c.params.workspaceId, c.body, c.requestId), 201)
  .workspace('POST', W + '/legal-holds/:holdId/release', c => privacy.releaseHold(c.actor, c.params.workspaceId, c.params.holdId, c.body, c.requestId))
  .workspace('GET', W + '/activation-readiness', c => privacy.readinessFor(c.actor, c.params.workspaceId));
