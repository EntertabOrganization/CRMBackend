'use client';
import { Console, type Section } from './kit';

const reason = { name: 'reason', required: true } as const;
const ver = { name: 'expectedVersion', type: 'number' as const, required: true };

/** Workspace-side Platform Services: my inbox/preferences, search, settings, support access, privacy and legal holds. */
const platformWorkspace: Section[] = [
  { title: 'My notifications', list: { label: 'Inbox', path: '/me/notifications', contextKey: 'notificationId' }, actions: [
    { label: 'Mark read', method: 'POST', path: '/me/notifications/:notificationId/read' },
    { label: 'Mark unread', method: 'POST', path: '/me/notifications/:notificationId/unread' },
    { label: 'Archive', method: 'POST', path: '/me/notifications/:notificationId/archive' },
    { label: 'Mark all read', method: 'POST', path: '/me/notifications/read-all' },
    { label: 'Notification preferences', method: 'GET', path: '/me/notification-preferences' },
    { label: 'Update preferences', method: 'PATCH', path: '/me/notification-preferences', fields: [{ name: 'channels', type: 'json', placeholder: '{"EMAIL":true,"PUSH":false,"IN_APP":true}' }, { name: 'topics', type: 'json', placeholder: '{"TASKS":{"EMAIL":false}}' }, { name: 'quietHours', type: 'json', placeholder: '{"start":"22:00","end":"07:00","timezone":"Africa/Cairo"}' }], describe: 'Mandatory security, access, billing and legal notices cannot be disabled.' },
    { label: 'Register device', method: 'POST', path: '/me/devices', fields: [{ name: 'platform', type: 'select', options: ['IOS', 'ANDROID', 'WEB'], required: true }, { name: 'token', required: true }] },
    { label: 'Revoke device', method: 'DELETE', path: '/me/devices/:deviceId', danger: true },
    { label: 'Language & timezone', method: 'GET', path: '/me/preferences' },
    { label: 'Update language & timezone', method: 'PATCH', path: '/me/preferences', fields: [{ name: 'locale', placeholder: 'en / ar-EG' }, { name: 'timezone', placeholder: 'Africa/Cairo' }, { name: 'dateFormat', type: 'select', options: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'D MMM YYYY'] }, { name: 'expectedVersion', type: 'number' }] },
  ] },
  { title: 'Search', actions: [
    { label: 'Global search', method: 'GET', path: '/search', query: [{ name: 'search', required: true }, { name: 'types', placeholder: 'site,hr.employee,marketing.campaign' }, { name: 'page', defaultValue: '1' }] },
    { label: 'Recent items', method: 'GET', path: '/me/recent' },
    { label: 'Favorites', method: 'GET', path: '/me/favorites' },
    { label: 'Add favorite', method: 'PUT', path: '/me/favorites/:entityType/:entityId' },
    { label: 'Remove favorite', method: 'DELETE', path: '/me/favorites/:entityType/:entityId' },
    { label: 'Rebuild search index', method: 'POST', path: '/search/reindex', fields: [{ name: 'types', type: 'json', placeholder: '[]' }], describe: 'Requires search.admin.' },
    { label: 'Reindex status', method: 'GET', path: '/search/reindex/:reindexId' },
  ] },
  { title: 'Workspace settings', actions: [
    { label: 'Current settings', method: 'GET', path: '/workspaces/current/settings' },
    { label: 'Update settings', method: 'PATCH', path: '/workspaces/current/settings', fields: [{ name: 'expectedVersion', type: 'number', required: true, defaultValue: '0' }, { name: 'values', type: 'json', required: true, placeholder: '{"defaultTimezone":"Africa/Cairo","defaultCurrency":"EGP","jurisdiction":"EG"}' }] },
    { label: 'Production activation readiness', method: 'GET', path: '/workspaces/:workspaceId/activation-readiness' },
  ] },
  { title: 'Support access', list: { label: 'Support requests', path: '/workspaces/:workspaceId/support-access', contextKey: 'grantId' }, actions: [
    { label: 'Approve read-only access', method: 'POST', path: '/workspaces/:workspaceId/support-access/:grantId/approve', fields: [ver, { name: 'reason' }] },
    { label: 'Reject', method: 'POST', path: '/workspaces/:workspaceId/support-access/:grantId/reject', fields: [ver, { name: 'reason' }], danger: true },
    { label: 'Revoke', method: 'POST', path: '/workspaces/:workspaceId/support-access/:grantId/revoke', fields: [ver, { name: 'reason' }], danger: true },
  ] },
  { title: 'Privacy & legal holds', list: { label: 'Privacy requests', path: '/workspaces/:workspaceId/privacy-requests', contextKey: 'requestId' }, actions: [
    { label: 'Submit privacy request', method: 'POST', path: '/workspaces/:workspaceId/privacy-requests', fields: [{ name: 'kind', type: 'select', options: ['EXPORT', 'ERASE', 'RECTIFY'], required: true }, { name: 'subjectRef', required: true, placeholder: 'email:person@example.com' }, reason] },
    { label: 'Request detail', method: 'GET', path: '/workspaces/:workspaceId/privacy-requests/:requestId' },
    { label: 'Decide', method: 'POST', path: '/workspaces/:workspaceId/privacy-requests/:requestId/decision', fields: [ver, { name: 'decision', type: 'select', options: ['APPROVE', 'DENY', 'COMPLETE_RECTIFICATION'], required: true }, { name: 'identityVerified', type: 'checkbox' }, reason], danger: true },
    { label: 'Download export', method: 'GET', path: '/workspaces/:workspaceId/privacy-requests/:requestId/export' },
    { label: 'Legal holds', method: 'GET', path: '/workspaces/:workspaceId/legal-holds' },
    { label: 'Apply legal hold', method: 'POST', path: '/workspaces/:workspaceId/legal-holds', fields: [{ name: 'scope', type: 'json', required: true, placeholder: '{"module":"*","scopeType":"WORKSPACE"}' }, reason, { name: 'authorityRef', required: true }] },
    { label: 'Release legal hold', method: 'POST', path: '/workspaces/:workspaceId/legal-holds/:holdId/release', fields: [reason], danger: true },
  ] },
];

/** Platform operator console: platform.* grants only (never Workspace data). Step-up actions need an MFA assertion. */
const platformAdmin: Section[] = [
  { title: 'Events & jobs', list: { label: 'Outbox events', path: '/platform/admin/events', contextKey: 'eventId' }, actions: [
    { label: 'Event deliveries', method: 'GET', path: '/platform/admin/events/:eventId/deliveries' },
    { label: 'Replay event', method: 'POST', path: '/platform/admin/events/:eventId/replay', fields: [{ name: 'consumerId', required: true }, reason], danger: true },
    { label: 'Jobs', method: 'GET', path: '/platform/admin/jobs', query: [{ name: 'state' }, { name: 'type' }] },
    { label: 'Job attempts', method: 'GET', path: '/platform/admin/jobs/:jobId/attempts' },
    { label: 'Retry job', method: 'POST', path: '/platform/admin/jobs/:jobId/retry', fields: [reason] },
    { label: 'Cancel job', method: 'POST', path: '/platform/admin/jobs/:jobId/cancel', fields: [reason], danger: true },
    { label: 'Schedules', method: 'GET', path: '/platform/admin/schedules' },
    { label: 'Update schedule', method: 'PATCH', path: '/platform/admin/schedules/:scheduleId', fields: [{ name: 'enabled', type: 'checkbox' }, { name: 'expectedVersion', type: 'number' }] },
  ] },
  { title: 'Audit & support', actions: [
    { label: 'Audit query', method: 'GET', path: '/platform/admin/audit', query: [{ name: 'workspaceId' }, { name: 'resourceType' }, { name: 'action' }, { name: 'from', type: 'datetime' }, { name: 'to', type: 'datetime' }] },
    { label: 'Security events', method: 'GET', path: '/platform/admin/security-events', query: [{ name: 'eventType' }, { name: 'workspaceId' }] },
    { label: 'Request support access', method: 'POST', path: '/platform/admin/support-access', fields: [{ name: 'workspaceId', required: true }, { name: 'purpose', type: 'textarea', required: true }, { name: 'scope', type: 'json', required: true, placeholder: '["crm.contact.read"]' }, { name: 'expiresAt', type: 'datetime', required: true }] },
    { label: 'Emergency access (break-glass)', method: 'POST', path: '/platform/admin/emergency-access', fields: [{ name: 'workspaceId', required: true }, { name: 'incidentRef', required: true }, { name: 'reason', type: 'textarea', required: true }, { name: 'scope', type: 'json', required: true }], danger: true },
    { label: 'Second approval', method: 'POST', path: '/platform/admin/emergency-access/:sessionId/approve', danger: true },
    { label: 'Post-incident review', method: 'POST', path: '/platform/admin/emergency-access/:sessionId/review', fields: [{ name: 'note', type: 'textarea', required: true }] },
  ] },
  { title: 'Configuration', actions: [
    { label: 'Global settings', method: 'GET', path: '/platform/admin/settings' },
    { label: 'Update global settings', method: 'PATCH', path: '/platform/admin/settings', fields: [{ name: 'expectedVersion', type: 'number', required: true, defaultValue: '0' }, { name: 'values', type: 'json', required: true, placeholder: '{"trialDays":14,"graceDays":15}' }] },
    { label: 'Feature flags', method: 'GET', path: '/platform/admin/feature-flags' },
    { label: 'Create flag', method: 'POST', path: '/platform/admin/feature-flags', fields: [{ name: 'name', required: true }, { name: 'description' }, { name: 'guardPermission' }] },
    { label: 'Update flag', method: 'PATCH', path: '/platform/admin/feature-flags/:flagId', fields: [ver, { name: 'state', type: 'select', options: ['ENABLED', 'DISABLED'] }, { name: 'rolloutPolicy', type: 'json', placeholder: '{"percent":100}' }, { name: 'targetScopes', type: 'json', placeholder: '[]' }] },
    { label: 'Rate limits', method: 'GET', path: '/platform/admin/rate-limits' },
    { label: 'Set rate limit', method: 'PUT', path: '/platform/admin/rate-limits', fields: [{ name: 'operationCode', required: true }, { name: 'principalScope', type: 'select', options: ['USER', 'IP', 'WORKSPACE', 'PROVIDER', 'PARTNER'], required: true }, { name: 'requests', type: 'number', required: true }, { name: 'windowSeconds', type: 'number', required: true }, { name: 'burst', type: 'number' }] },
    { label: 'Invalidate cache', method: 'POST', path: '/platform/admin/cache/invalidate', fields: [{ name: 'namespace', required: true }, { name: 'scopeId', required: true }, reason] },
    { label: 'Retention policies', method: 'GET', path: '/platform/retention/policies' },
    { label: 'Create retention policy', method: 'POST', path: '/platform/retention/policies', fields: [{ name: 'jurisdiction', required: true }, { name: 'category', required: true }, { name: 'durationDays', type: 'number' }, { name: 'action', type: 'select', options: ['DELETE', 'ANONYMIZE', 'ARCHIVE'], required: true }, { name: 'legalBasis', required: true }, { name: 'effectiveFrom', type: 'datetime', required: true }] },
  ] },
  { title: 'Operations', actions: [
    { label: 'Metrics', method: 'GET', path: '/platform/admin/ops/metrics' },
    { label: 'Alerts', method: 'GET', path: '/platform/admin/ops/alerts', query: [{ name: 'state', type: 'select', options: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] }] },
    { label: 'Acknowledge alert', method: 'POST', path: '/platform/admin/ops/alerts/:alertId/acknowledge' },
    { label: 'Resolve alert', method: 'POST', path: '/platform/admin/ops/alerts/:alertId/resolve' },
    { label: 'Alert rules', method: 'GET', path: '/platform/admin/ops/alert-rules' },
    { label: 'Set alert rule', method: 'PUT', path: '/platform/admin/ops/alert-rules', fields: [{ name: 'metric', type: 'select', options: ['queue_lag', 'outbox_lag_seconds', 'search_lag', 'dead_letters', 'failed_jobs', 'notification_failures'], required: true }, { name: 'threshold', type: 'number', required: true }, { name: 'escalationTarget', required: true }, { name: 'enabled', type: 'checkbox', defaultValue: 'true' }] },
    { label: 'Recovery plans', method: 'GET', path: '/platform/admin/ops/recovery-plans' },
    { label: 'Set recovery plan', method: 'PUT', path: '/platform/admin/ops/recovery-plans', fields: [{ name: 'environment', required: true }, { name: 'backupProfileId', required: true }, { name: 'targetRpoMinutes', type: 'number', required: true }, { name: 'targetRtoMinutes', type: 'number', required: true }, { name: 'procedureRef', required: true }, { name: 'expectedVersion', type: 'number', defaultValue: '0' }] },
    { label: 'Request restore test', method: 'POST', path: '/platform/admin/ops/restore-tests', fields: [{ name: 'backupId', required: true }, { name: 'isolatedEnvironment', required: true }, { name: 'planEnvironment' }], danger: true },
  ] },
];

export const PlatformConsole = () => <Console product="Platform" storageKey="suite-platform-session" sections={[...platformWorkspace, ...platformAdmin]} />;
