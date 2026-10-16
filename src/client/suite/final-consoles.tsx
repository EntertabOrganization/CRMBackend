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

/** Workspace billing: plans, subscription lifecycle, invoices/payments, usage & credits, recovery. */
const billing: Section[] = [
  { title: 'Plans & subscription', actions: [
    { label: 'Available plans', method: 'GET', path: '/billing/plans', query: [{ name: 'currency', placeholder: 'USD' }, { name: 'period', type: 'select', options: ['MONTHLY', 'YEARLY'] }] },
    { label: 'Current subscription', method: 'GET', path: '/billing/subscriptions/current' },
    { label: 'Effective entitlements', method: 'GET', path: '/billing/workspaces/current/entitlements' },
    { label: 'Start 14-day trial', method: 'POST', path: '/billing/subscriptions/trial', fields: [{ name: 'planVersionId', required: true }], describe: 'No payment method needed; no automatic charge.' },
    { label: 'Buy plan (quote + invoice)', method: 'POST', path: '/billing/subscriptions', fields: [{ name: 'planVersionId', required: true }, { name: 'priceId', required: true }, { name: 'payerAccountId', required: true }, { name: 'idempotencyKey', required: true }] },
    { label: 'Subscription history', method: 'GET', path: '/billing/subscriptions/history' },
    { label: 'Entitlement history', method: 'GET', path: '/billing/subscriptions/:subscriptionId/entitlement-history' },
    { label: 'Cancel at period end', method: 'POST', path: '/billing/subscriptions/:subscriptionId/cancel', fields: [{ name: 'atPeriodEnd', type: 'checkbox', defaultValue: 'true' }, reason], danger: true },
    { label: 'Reactivate', method: 'POST', path: '/billing/subscriptions/:subscriptionId/reactivate' },
    { label: 'Renew now (issue invoice)', method: 'POST', path: '/billing/subscriptions/:subscriptionId/renew' },
  ] },
  { title: 'Plan change', actions: [
    { label: 'Quote plan change', method: 'POST', path: '/billing/subscriptions/:subscriptionId/change-quotes', fields: [{ name: 'targetPlanVersionId', required: true }, { name: 'targetPriceId' }, { name: 'requestedTiming', type: 'select', options: ['IMMEDIATE', 'AT_RENEWAL'] }], describe: 'Shows proration and compatibility findings before you commit.' },
    { label: 'Confirm change', method: 'POST', path: '/billing/subscriptions/:subscriptionId/change', fields: [{ name: 'quoteId', required: true }, { name: 'idempotencyKey', required: true }] },
    { label: 'Compatibility check', method: 'GET', path: '/billing/compatibility-checks/:checkId' },
    { label: 'Cancel scheduled change', method: 'POST', path: '/billing/subscriptions/:subscriptionId/scheduled-change/cancel', danger: true },
  ] },
  { title: 'Invoices & payments', list: { label: 'Invoices', path: '/billing/invoices', contextKey: 'invoiceId' }, actions: [
    { label: 'Invoice detail', method: 'GET', path: '/billing/invoices/:invoiceId' },
    { label: 'Billing accounts', method: 'GET', path: '/billing/accounts' },
    { label: 'Create billing account', method: 'POST', path: '/billing/accounts', fields: [{ name: 'payerType', type: 'select', options: ['CUSTOMER', 'PARTNER'] }, { name: 'partnerId' }, { name: 'billingCurrency', required: true, defaultValue: 'USD' }, { name: 'legalIdentity', type: 'json', required: true, placeholder: '{"legalName":"Acme LLC","country":"EG"}' }] },
    { label: 'Pay (hosted checkout)', method: 'POST', path: '/billing/payment-attempts', fields: [{ name: 'quoteId', required: true }, { name: 'providerId', type: 'select', options: ['stripe', 'xpay', 'sandbox'], required: true }, { name: 'idempotencyKey', required: true }], describe: 'Activation happens only after the provider confirms payment.' },
    { label: 'Refresh payment status', method: 'POST', path: '/billing/payment-attempts/:attemptId/refresh' },
    { label: 'Request payer change approval', method: 'POST', path: '/billing/approvals', fields: [{ name: 'action', defaultValue: 'PAYER_TRANSITION', required: true }, { name: 'payload', type: 'json', required: true, placeholder: '{"subscriptionId":"…","newPayerAccountId":"…"}' }, reason] },
    { label: 'Owner: decide approval', method: 'POST', path: '/billing/approvals/:approvalId/decision', fields: [{ name: 'decision', type: 'select', options: ['APPROVED', 'REJECTED'], required: true }, reason] },
    { label: 'Transition payer', method: 'POST', path: '/billing/accounts/transition-payer', fields: [{ name: 'subscriptionId', required: true }, { name: 'newPayerAccountId', required: true }, { name: 'customerOwnerConsentRef', required: true }, { name: 'approvalRef', required: true }], danger: true },
    { label: 'Partner transactions', method: 'GET', path: '/billing/partner-transactions' },
  ] },
  { title: 'Usage & credits', actions: [
    { label: 'Usage meters', method: 'GET', path: '/billing/usage', query: [{ name: 'meterCode' }, { name: 'period', placeholder: '2026-10' }] },
    { label: 'Accept overage price & cap', method: 'POST', path: '/billing/overage-policies', fields: [{ name: 'code', required: true }, { name: 'acceptedLimit', required: true }, { name: 'acceptedPriceVersion', required: true }, { name: 'enabled', type: 'checkbox', defaultValue: 'true' }] },
    { label: 'Credit balance', method: 'GET', path: '/billing/credits/balance' },
    { label: 'Credit ledger', method: 'GET', path: '/billing/credits/ledger', query: [{ name: 'from', type: 'datetime' }, { name: 'to', type: 'datetime' }] },
    { label: 'Top-up products', method: 'GET', path: '/billing/credits/products' },
    { label: 'Top-up quote', method: 'POST', path: '/billing/credits/topup-quote', fields: [{ name: 'productId', required: true }, { name: 'amount', type: 'number', defaultValue: '1' }, { name: 'payerAccountId', required: true }] },
    { label: 'Buy top-up', method: 'POST', path: '/billing/credits/topup-purchase', fields: [{ name: 'quoteId', required: true }, { name: 'payerAccountId', required: true }, { name: 'idempotencyKey', required: true }] },
  ] },
  { title: 'Recovery & reports', actions: [
    { label: 'Recovery case', method: 'GET', path: '/billing/subscriptions/:subscriptionId/recovery-case' },
    { label: 'Retry payment', method: 'POST', path: '/billing/subscriptions/:subscriptionId/retry-payment' },
    { label: 'Revenue report', method: 'GET', path: '/billing/reports/revenue', query: [{ name: 'period', required: true, placeholder: '2026-10' }, { name: 'currency' }] },
    { label: 'Usage report', method: 'GET', path: '/billing/reports/usage', query: [{ name: 'period', required: true, placeholder: '2026-10' }] },
    { label: 'Billing audit', method: 'GET', path: '/billing/admin/audit', query: [{ name: 'entityId' }] },
    { label: 'Billing preferences', method: 'GET', path: '/billing/preferences' },
    { label: 'Update preferences', method: 'PATCH', path: '/billing/preferences', fields: [{ name: 'expectedVersion', type: 'number', required: true, defaultValue: '0' }, { name: 'invoiceDeliveryEmail' }, { name: 'currency' }] },
  ] },
];

/** Platform billing administration (catalog, finance, reconciliation, overrides). */
const billingAdmin: Section[] = [
  { title: 'Catalog (platform)', list: { label: 'Plans', path: '/platform/billing/plans', contextKey: 'planId' }, actions: [
    { label: 'Entitlement definitions', method: 'GET', path: '/platform/billing/definitions' },
    { label: 'Create plan', method: 'POST', path: '/platform/billing/plans', fields: [{ name: 'code', required: true }, { name: 'name', required: true }] },
    { label: 'Create plan version (draft)', method: 'POST', path: '/platform/billing/plans/:planId/versions', fields: [{ name: 'entitlements', type: 'json', required: true, placeholder: '{"sites":true,"sites.max":3,"ai":true,"ai.credits":1000}' }, { name: 'prices', type: 'json', required: true, placeholder: '[{"currency":"USD","amount":"49.00","period":"MONTHLY"}]' }, { name: 'trialDays', type: 'number' }] },
    { label: 'Publish version (immutable)', method: 'POST', path: '/platform/billing/plan-versions/:versionId/publish', danger: true },
    { label: 'Retire version', method: 'POST', path: '/platform/billing/plan-versions/:versionId/retire', danger: true },
    { label: 'Create top-up product', method: 'POST', path: '/platform/billing/topup-products', fields: [{ name: 'code', required: true }, { name: 'name', required: true }, { name: 'units', required: true }, { name: 'price', required: true }, { name: 'currency', required: true }, { name: 'expiresInDays', type: 'number' }] },
    { label: 'Publish overage rate', method: 'POST', path: '/platform/billing/overage-rates', fields: [{ name: 'code', required: true }, { name: 'version', required: true }, { name: 'rate', required: true }, { name: 'currency', required: true }] },
  ] },
  { title: 'Finance (platform)', actions: [
    { label: 'Payments', method: 'GET', path: '/platform/billing/payments', query: [{ name: 'workspaceId' }] },
    { label: 'Revenue', method: 'GET', path: '/platform/billing/revenue', query: [{ name: 'period', required: true }, { name: 'currency' }, { name: 'workspaceId' }] },
    { label: 'Start reconciliation', method: 'POST', path: '/platform/billing/reconciliations', fields: [{ name: 'providerId', type: 'select', options: ['stripe', 'xpay', 'sandbox'], required: true }, { name: 'period', required: true, placeholder: '2026-10' }] },
    { label: 'Reconciliation run', method: 'GET', path: '/platform/billing/reconciliations/:runId' },
    { label: 'Findings', method: 'GET', path: '/platform/billing/reconciliations/:runId/findings' },
    { label: 'Resolve finding', method: 'POST', path: '/platform/billing/reconciliations/findings/:findingId/resolve', fields: [{ name: 'resolution', type: 'select', options: ['INVESTIGATING', 'APPLY_VERIFIED_PAYMENT', 'NO_ACTION_REQUIRED', 'IGNORED'], required: true }, reason] },
    { label: 'Publish FX rate', method: 'POST', path: '/platform/billing/fx-rates', fields: [{ name: 'period', required: true }, { name: 'base', required: true }, { name: 'quote', required: true }, { name: 'rate', required: true }] },
    { label: 'Compute MRR facts', method: 'POST', path: '/platform/billing/mrr', fields: [{ name: 'period', required: true }, { name: 'reportingCurrency', required: true, defaultValue: 'USD' }] },
    { label: 'Approvals', method: 'GET', path: '/platform/billing/approvals' },
    { label: 'Request approval', method: 'POST', path: '/platform/billing/approvals', fields: [{ name: 'action', type: 'select', options: ['REFUND', 'ENTITLEMENT_OVERRIDE', 'CREDIT_ADJUSTMENT'], required: true }, { name: 'payload', type: 'json', required: true }, reason] },
    { label: 'Decide approval', method: 'POST', path: '/platform/billing/approvals/:approvalId/decision', fields: [{ name: 'decision', type: 'select', options: ['APPROVED', 'REJECTED'], required: true }, reason] },
    { label: 'Refund payment', method: 'POST', path: '/billing/refunds', fields: [{ name: 'paymentId', required: true }, { name: 'amount', required: true }, reason, { name: 'idempotencyKey', required: true }, { name: 'approvalId' }], danger: true },
    { label: 'Entitlement override', method: 'POST', path: '/platform/billing/overrides', fields: [{ name: 'workspaceId', required: true }, { name: 'feature', required: true }, { name: 'value', type: 'json', required: true }, reason, { name: 'expiresAt', type: 'datetime', required: true }, { name: 'approvalId', required: true }], danger: true },
    { label: 'Credit adjustment', method: 'POST', path: '/platform/billing/credits/adjust', fields: [{ name: 'workspaceId', required: true }, { name: 'kind', type: 'select', options: ['GRANT', 'REVERSE'], required: true }, { name: 'units', required: true }, { name: 'grantId' }, reason, { name: 'approvalId', required: true }], danger: true },
  ] },
];

export const BillingConsole = () => <Console product="Billing" storageKey="suite-billing-session" sections={[...billing, ...billingAdmin]} />;

/** Partner portal (Partner membership scope) + customer-side Partner controls + platform Partner administration. */
const partnerPortal: Section[] = [
  { title: 'My Partner organizations', list: { label: 'My Partners', path: '/partners/me', contextKey: 'partnerId' }, actions: [
    { label: 'Apply to become a Partner', method: 'POST', path: '/public/partners/applications', fields: [{ name: 'firstName', required: true }, { name: 'lastName', required: true }, { name: 'email', required: true }, { name: 'phone', required: true, placeholder: '+201001234567' }, { name: 'partnerName', required: true }, { name: 'country', required: true, placeholder: 'EG' }, { name: 'website', placeholder: 'https://…' }, { name: 'businessDescription', type: 'textarea', required: true }, { name: 'termsAccepted', type: 'checkbox', required: true }, { name: 'privacyAccepted', type: 'checkbox', required: true }] },
    { label: 'My applications', method: 'GET', path: '/partners/applications/me' },
    { label: 'Accept invitation', method: 'POST', path: '/partners/invitations/accept', fields: [{ name: 'token', required: true }] },
    { label: 'Dashboard', method: 'GET', path: '/partners/:partnerId/dashboard', query: [{ name: 'period', placeholder: '2026-10' }, { name: 'currency' }] },
  ] },
  { title: 'Team', actions: [
    { label: 'Members', method: 'GET', path: '/partners/:partnerId/members', query: [{ name: 'search' }, { name: 'status', type: 'select', options: ['ACTIVE', 'SUSPENDED', 'REMOVED'] }] },
    { label: 'Invite member', method: 'POST', path: '/partners/:partnerId/members/invitations', fields: [{ name: 'email', required: true }, { name: 'roleId', required: true }] },
    { label: 'Change member', method: 'PATCH', path: '/partners/:partnerId/members/:memberId', fields: [ver, { name: 'roleId' }, { name: 'status', type: 'select', options: ['ACTIVE', 'SUSPENDED', 'REMOVED'] }], danger: true },
    { label: 'Roles', method: 'GET', path: '/partners/:partnerId/roles' },
    { label: 'Create custom role', method: 'POST', path: '/partners/:partnerId/roles', fields: [{ name: 'name', required: true }, { name: 'permissions', type: 'json', required: true, placeholder: '[{"code":"partner.workspace.read","scope":"OWN_RELATIONSHIPS"}]' }] },
  ] },
  { title: 'Customers', actions: [
    { label: 'Customer workspaces', method: 'GET', path: '/partners/:partnerId/customer-workspaces', query: [{ name: 'search' }, { name: 'status', type: 'select', options: ['ACTIVE', 'ENDED'] }] },
    { label: 'Provision customer workspace', method: 'POST', path: '/partners/:partnerId/customer-workspaces', fields: [{ name: 'customerUserId', required: true }, { name: 'workspaceName', required: true }, { name: 'idempotencyKey', required: true }], describe: 'The customer becomes the Workspace owner.' },
    { label: 'Link existing workspace', method: 'POST', path: '/partners/:partnerId/workspaces/:workspaceId/relationship', fields: [{ name: 'customerOwnerConsentRef', required: true }] },
    { label: 'End relationship', method: 'POST', path: '/partners/:partnerId/workspaces/:workspaceId/relationship/end', fields: [reason, { name: 'approvalRef', required: true }], danger: true },
    { label: 'Request delegated access', method: 'POST', path: '/partners/:partnerId/access-requests', fields: [{ name: 'workspaceId', required: true }, { name: 'requestedPermissions', type: 'json', required: true, placeholder: '["crm.contact.read"]' }, { name: 'expiresAt', type: 'datetime', required: true }, reason] },
    { label: 'My delegations', method: 'GET', path: '/partners/:partnerId/delegations' },
    { label: 'Discounts', method: 'GET', path: '/partners/:partnerId/discounts' },
  ] },
  { title: 'Referrals & earnings', actions: [
    { label: 'Create referral link', method: 'POST', path: '/partners/:partnerId/referral-links', fields: [{ name: 'campaignLabel', required: true }, { name: 'windowDays', type: 'number', required: true, defaultValue: '30' }] },
    { label: 'Referral stats', method: 'GET', path: '/partners/:partnerId/referrals' },
    { label: 'Commissions', method: 'GET', path: '/partners/:partnerId/commissions', query: [{ name: 'status' }, { name: 'period' }] },
    { label: 'Request payout', method: 'POST', path: '/partners/:partnerId/payout-requests', fields: [{ name: 'commissionIds', type: 'json', required: true }, { name: 'idempotencyKey', required: true }] },
    { label: 'Payouts', method: 'GET', path: '/partners/:partnerId/payouts' },
    { label: 'Export report', method: 'POST', path: '/partners/:partnerId/reports/export', fields: [{ name: 'period', required: true }, { name: 'fields', type: 'json', placeholder: '["eligibleRevenue","commissionAccrued","payouts"]' }] },
    { label: 'Download report', method: 'GET', path: '/partners/:partnerId/reports/:jobId/download' },
  ] },
  { title: 'Customer: Partner access (workspace)', actions: [
    { label: 'Partner access grants', method: 'GET', path: '/workspaces/:workspaceId/partner-access' },
    { label: 'Approve access', method: 'POST', path: '/workspaces/:workspaceId/partner-access/:grantId/approve', fields: [{ name: 'permissions', type: 'json', required: true }, { name: 'expiresAt', type: 'datetime', required: true }, ver] },
    { label: 'Revoke access', method: 'POST', path: '/workspaces/:workspaceId/partner-access/:grantId/revoke', fields: [reason], danger: true },
    { label: 'Request Partner transfer', method: 'POST', path: '/workspaces/:workspaceId/partner-transfer-requests', fields: [{ name: 'toPartnerId', required: true }, reason] },
  ] },
  { title: 'Platform: Partners', list: { label: 'Applications', path: '/platform/partner-applications', contextKey: 'applicationId' }, actions: [
    { label: 'Approve application', method: 'POST', path: '/platform/partner-applications/:applicationId/approve', fields: [ver, { name: 'idempotencyKey', required: true }] },
    { label: 'Reject application', method: 'POST', path: '/platform/partner-applications/:applicationId/reject', fields: [reason, ver], danger: true },
    { label: 'Partners', method: 'GET', path: '/platform/partners', query: [{ name: 'search' }, { name: 'status', type: 'select', options: ['ACTIVE', 'SUSPENDED'] }, { name: 'country' }] },
    { label: 'Add discount rule', method: 'POST', path: '/platform/partners/:partnerId/discount-rules', fields: [{ name: 'targetType', type: 'select', options: ['DEFAULT', 'CATEGORY', 'PRODUCT'], required: true }, { name: 'targetId' }, { name: 'basisPoints', type: 'number', required: true }, { name: 'validFrom', type: 'datetime', required: true }, { name: 'validUntil', type: 'datetime' }] },
    { label: 'Suspend Partner', method: 'POST', path: '/platform/partners/:partnerId/suspend', fields: [reason, ver], danger: true },
    { label: 'Reactivate Partner', method: 'POST', path: '/platform/partners/:partnerId/reactivate', fields: [reason] },
    { label: 'Approve transfer', method: 'POST', path: '/platform/partner-transfers/:transferId/approve', fields: [{ name: 'decision', type: 'select', options: ['APPROVED', 'REJECTED'] }, reason] },
    { label: 'Commission policy', method: 'POST', path: '/platform/partner-commission-policies', fields: [{ name: 'partnerId' }, { name: 'productCategory', type: 'select', options: ['SUBSCRIPTION', 'CREDITS', 'OTHER'], required: true }, { name: 'method', type: 'select', options: ['PERCENT', 'FIXED'], required: true }, { name: 'rate', type: 'number', required: true }, { name: 'currency', required: true }, { name: 'effectiveAt', type: 'datetime', required: true }] },
    { label: 'Payout queue', method: 'GET', path: '/platform/partner-payouts', query: [{ name: 'status' }] },
    { label: 'Approve payout', method: 'POST', path: '/platform/partner-payouts/:payoutId/approve', fields: [{ name: 'expectedAmount', required: true }, reason], danger: true },
    { label: 'Record payment', method: 'POST', path: '/platform/partner-payouts/:payoutId/record-payment', fields: [{ name: 'externalReference', required: true }, { name: 'paidAt', type: 'datetime', required: true }, { name: 'amount', required: true }, { name: 'currency', required: true }], danger: true },
  ] },
];

export const PartnerConsole = () => <Console product="Partner Program" storageKey="suite-partner-session" sections={partnerPortal} />;
