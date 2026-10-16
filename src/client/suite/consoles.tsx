'use client';
import { Console, type Section } from './kit';

const reason = { name: 'reason', required: true } as const;
const version = (name = 'expectedVersion') => ({ name, type: 'number' as const, required: true });

/** Online Store / Commerce operator console (stores, listings, orders, fulfillment, payments, reports, CRM sync). */
const commerce: Section[] = [
  { title: 'Stores', list: { label: 'Stores', path: '/commerce/stores', contextKey: 'storeId' }, actions: [
    { label: 'Create store', method: 'POST', path: '/commerce/stores', fields: [{ name: 'name', required: true }, { name: 'slug', required: true }, { name: 'defaultCurrency', required: true, defaultValue: 'EGP' }, { name: 'timezone', required: true, defaultValue: 'Africa/Cairo' }, { name: 'catalogId', required: true }, { name: 'mode', type: 'select', options: ['WEB', 'HEADLESS', 'HYBRID'] }, { name: 'defaultLocale', defaultValue: 'en' }, { name: 'policy', type: 'json', placeholder: '{"reservationTtlSeconds":1800,"guestCheckoutEnabled":true}' }] },
    { label: 'Readiness', method: 'GET', path: '/commerce/stores/:storeId/readiness', describe: 'Payment, delivery, tax, TTL, retention, channel and publication blockers.' },
    { label: 'Update policy', method: 'PATCH', path: '/commerce/stores/:storeId/policy', fields: [{ name: 'expectedPolicyVersion', type: 'number', required: true }, { name: 'reservationTtlSeconds', type: 'number' }, { name: 'backordersEnabled', type: 'checkbox' }, { name: 'guestCheckoutEnabled', type: 'checkbox', defaultValue: 'true' }, { name: 'portalEnabled', type: 'checkbox', defaultValue: 'true' }, { name: 'retentionConfigured', type: 'checkbox' }, { name: 'allowedReturnHosts', type: 'json', placeholder: '["shop.example.com"]' }, { name: 'digitalAccessPolicy', type: 'json', placeholder: '{"downloadLimit":3,"accessDays":30,"revokeOnRefund":true}' }] },
    { label: 'Activate', method: 'POST', path: '/commerce/stores/:storeId/activate', fields: [{ name: 'expectedVersion', required: true }] },
    { label: 'Suspend', method: 'POST', path: '/commerce/stores/:storeId/suspend', fields: [{ name: 'expectedVersion', required: true }], danger: true },
    { label: 'Add channel route', method: 'POST', path: '/commerce/stores/:storeId/channels', fields: [{ name: 'routePrefix', required: true, placeholder: '/shop' }, { name: 'hostname' }, { name: 'siteId' }] },
    { label: 'Entitlement impact', method: 'GET', path: '/commerce/stores/:storeId/entitlement-impact' },
    { label: 'Archive store', method: 'POST', path: '/commerce/stores/:storeId/archive', fields: [{ name: 'expectedVersion', required: true }, reason], danger: true },
  ] },
  { title: 'Catalog', actions: [
    { label: 'Publish product', method: 'PUT', path: '/commerce/stores/:storeId/publications/:productId', fields: [{ name: 'published', type: 'checkbox', defaultValue: 'true' }, { name: 'seoSlug', required: true }, { name: 'expectedVersion' }] },
    { label: 'Listing override (price/categories)', method: 'PATCH', path: '/commerce/listings/:listingId', fields: [{ name: 'price', type: 'json', placeholder: '{"amount":"99.00","currency":"EGP"}' }, { name: 'categoryIds', type: 'json' }, { name: 'sortRank', type: 'number' }, { name: 'seoOverrides', type: 'json' }] },
    { label: 'Price preview', method: 'GET', path: '/commerce/stores/:storeId/price-preview', query: [{ name: 'productId', required: true }, { name: 'variantId' }, { name: 'qty', defaultValue: '1' }] },
    { label: 'Store categories', method: 'GET', path: '/commerce/stores/:storeId/categories' },
    { label: 'Create category', method: 'POST', path: '/commerce/stores/:storeId/categories', fields: [{ name: 'name', required: true }, { name: 'slug', required: true }, { name: 'parentId' }, { name: 'sortRank', type: 'number' }] },
    { label: 'Add tax rule', method: 'POST', path: '/commerce/stores/:storeId/tax-rules', fields: [{ name: 'region', required: true, defaultValue: '*' }, { name: 'rate', required: true, defaultValue: '0' }, { name: 'priceBasis', type: 'select', options: ['EXCLUSIVE', 'INCLUSIVE'], required: true }, { name: 'effectiveFrom', type: 'datetime', required: true }] },
  ] },
  { title: 'Orders', list: { label: 'Orders', path: '/commerce/orders', contextKey: 'orderId' }, actions: [
    { label: 'Order detail', method: 'GET', path: '/commerce/orders/:orderId' },
    { label: 'Availability & reservations', method: 'GET', path: '/commerce/orders/:orderId/availability' },
    { label: 'Transition status', method: 'POST', path: '/commerce/orders/:orderId/transition', fields: [{ name: 'expectedVersion', required: true }, { name: 'to', required: true, placeholder: 'CONFIRMED / PROCESSING / COMPLETED / custom' }, { name: 'reason' }] },
    { label: 'Amend quantities', method: 'POST', path: '/commerce/orders/:orderId/amend', fields: [{ name: 'expectedVersion', required: true }, reason, { name: 'preview', type: 'checkbox', defaultValue: 'true' }, { name: 'lines', type: 'json', required: true, placeholder: '[{"orderLineId":"…","quantity":"1"}]' }] },
    { label: 'Refresh reservations', method: 'POST', path: '/commerce/orders/:orderId/reservations/refresh' },
    { label: 'Resolve stock exception', method: 'POST', path: '/commerce/orders/:orderId/backorder-action', fields: [{ name: 'action', type: 'select', options: ['BACKORDER', 'REALLOCATE', 'REFUND', 'CANCEL_BACKORDER'], required: true }, { name: 'orderLineId' }, { name: 'expectedDate', type: 'date' }, reason] },
    { label: 'Cancel order', method: 'POST', path: '/commerce/orders/:orderId/cancel', fields: [{ name: 'expectedVersion', required: true }, reason], danger: true },
    { label: 'Issue guest order link', method: 'POST', path: '/commerce/orders/:orderId/guest-access-links' },
  ] },
  { title: 'Payments', actions: [
    { label: 'Create payment intent', method: 'POST', path: '/commerce/orders/:orderId/payment-intents', fields: [{ name: 'paymentMethodId', required: true }, { name: 'returnUrl' }], describe: 'Amount is always resolved from the order.' },
    { label: 'Issue payment link', method: 'POST', path: '/commerce/orders/:orderId/payment-links', fields: [{ name: 'expiresInMinutes', type: 'number', defaultValue: '1440' }] },
    { label: 'Issue link in conversation', method: 'POST', path: '/commerce/conversations/:conversationId/payment-links', fields: [{ name: 'orderId', required: true }, { name: 'expiresInMinutes', type: 'number' }] },
    { label: 'Revoke payment link', method: 'POST', path: '/commerce/payment-links/:linkId/revoke', danger: true },
    { label: 'Order payments', method: 'GET', path: '/commerce/orders/:orderId/payments' },
    { label: 'Reconcile with provider', method: 'POST', path: '/commerce/orders/:orderId/reconcile' },
    { label: 'Request refund', method: 'POST', path: '/commerce/orders/:orderId/refunds', fields: [{ name: 'paymentId', required: true }, { name: 'amount', required: true }, reason] },
  ] },
  { title: 'Fulfillment', actions: [
    { label: 'Plan fulfillment', method: 'POST', path: '/commerce/orders/:orderId/fulfillments', fields: [{ name: 'type', type: 'select', options: ['SHIP', 'PICKUP'], required: true }, { name: 'warehouseId', required: true }, { name: 'deliveryServiceId' }, { name: 'lines', type: 'json', required: true, placeholder: '[{"orderLineId":"…","quantity":"1"}]' }] },
    { label: 'Update fulfillment', method: 'PATCH', path: '/commerce/fulfillments/:fulfillmentId', fields: [version(), { name: 'status', type: 'select', options: ['PICKING', 'PACKED', 'DONE', 'CANCELLED'] }, { name: 'handoffConfirmation', type: 'json', placeholder: '{"receivedBy":"Name"}' }] },
    { label: 'Dispatch shipment', method: 'POST', path: '/commerce/shipments/:shipmentId/dispatch', fields: [{ name: 'expectedVersion', required: true }] },
    { label: 'Add tracking number', method: 'POST', path: '/commerce/shipments/:shipmentId/tracking', fields: [{ name: 'expectedVersion', required: true }, { name: 'trackingNumber', required: true }, { name: 'carrierKey' }] },
    { label: 'Return history', method: 'GET', path: '/commerce/returns/:returnId/history' },
    { label: 'Refund a return', method: 'POST', path: '/commerce/returns/:returnId/refund', fields: [{ name: 'paymentId', required: true }, { name: 'amount', required: true }, reason] },
    { label: 'Grant digital access', method: 'POST', path: '/commerce/orders/:orderId/digital-fulfillment', fields: [{ name: 'items', type: 'json', required: true, placeholder: '[{"orderLineId":"…","fileId":"…"}]' }] },
    { label: 'Revoke digital access (after refund)', method: 'POST', path: '/commerce/orders/:orderId/digital-revoke', fields: [reason], danger: true },
    { label: 'Complete service line', method: 'POST', path: '/commerce/services/:orderLineId/complete', fields: [{ name: 'orderId', required: true }, { name: 'outcome', type: 'select', options: ['DELIVERED', 'CANCELLED'] }] },
  ] },
  { title: 'Reports & sync', actions: [
    ...(['orders', 'revenue', 'abandoned-carts', 'fulfillment'] as const).map(kind => ({ label: 'Report: ' + kind, method: 'GET' as const, path: '/commerce/reports/' + kind, query: [{ name: 'storeId' }, { name: 'from', type: 'datetime' as const }, { name: 'to', type: 'datetime' as const }] })),
    { label: 'CRM sync failures', method: 'GET', path: '/commerce/sync/failures' },
    { label: 'Retry CRM sync', method: 'POST', path: '/commerce/sync/retry/:syncId' },
    { label: 'Contact orders (CRM)', method: 'GET', path: '/crm/contacts/:contactId/commerce/orders' },
  ] },
];

/** Marketing campaigns console. */
const marketing: Section[] = [
  { title: 'Audiences', list: { label: 'Segments', path: '/marketing/segments', contextKey: 'segmentId' }, actions: [
    { label: 'Create segment', method: 'POST', path: '/marketing/segments', fields: [{ name: 'name', required: true }, { name: 'kind', type: 'select', options: ['STATIC', 'DYNAMIC'], required: true }, { name: 'channel', type: 'select', options: ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'] }, { name: 'ruleTree', type: 'json', placeholder: '{"op":"AND","rules":[{"field":"city","operator":"eq","value":"Cairo"}]}' }, { name: 'exclusions', type: 'json' }] },
    { label: 'Preview segment', method: 'POST', path: '/marketing/segments/:segmentId/preview' },
    { label: 'Add contacts', method: 'POST', path: '/marketing/segments/:segmentId/members', fields: [{ name: 'contactIds', type: 'json', required: true, placeholder: '["…"]' }] },
    { label: 'Import CSV (from Files)', method: 'POST', path: '/marketing/audiences/import-jobs', fields: [{ name: 'fileId', required: true }, { name: 'segmentId', required: true }, { name: 'fieldMapping', type: 'json', required: true, defaultValue: '{"destination":"email","firstName":"first_name"}' }, { name: 'duplicatePolicy', type: 'select', options: ['SKIP', 'UPDATE_METADATA'] }], describe: 'Imports never create marketing consent.' },
    { label: 'Confirm import', method: 'POST', path: '/marketing/audiences/import-jobs/:importId/confirm' },
    { label: 'Import errors', method: 'GET', path: '/marketing/audiences/import-jobs/:importId/errors' },
  ] },
  { title: 'Consent', actions: [
    { label: 'Configure consent policy', method: 'PUT', path: '/marketing/consent-policies', fields: [{ name: 'jurisdiction', required: true, defaultValue: 'DEFAULT' }, { name: 'channel', type: 'select', options: ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'], required: true }, { name: 'purpose', type: 'select', options: ['MARKETING', 'NEWSLETTER', 'PROMOTIONAL', 'ADVERTISING'], required: true }, { name: 'consentRequired', type: 'checkbox', defaultValue: 'true' }, { name: 'quietHours', type: 'json' }, { name: 'frequencyCap', type: 'json' }] },
    { label: 'Record consent', method: 'POST', path: '/marketing/consents', fields: [{ name: 'subject', type: 'json', required: true, placeholder: '{"destination":"name@example.com"}' }, { name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'purpose', required: true, defaultValue: 'MARKETING' }, { name: 'lawfulBasis', required: true, defaultValue: 'CONSENT' }, { name: 'source', required: true, defaultValue: 'WEB_FORM' }, { name: 'jurisdiction', required: true, defaultValue: 'DEFAULT' }, { name: 'evidenceFileId' }] },
    { label: 'Withdraw consent', method: 'POST', path: '/marketing/consents/withdraw', fields: [{ name: 'subject', type: 'json', required: true }, { name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'purpose', required: true, defaultValue: 'MARKETING' }] },
    { label: 'Suppressions', method: 'GET', path: '/marketing/suppressions' },
    { label: 'Eligibility preview', method: 'POST', path: '/marketing/eligibility/preview', fields: [{ name: 'subject', type: 'json', required: true }, { name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'purpose', required: true, defaultValue: 'MARKETING' }] },
  ] },
  { title: 'Channels', list: { label: 'Provider connections', path: '/marketing/providers', contextKey: 'providerId' }, actions: [
    { label: 'Connect provider', method: 'POST', path: '/marketing/providers/connect', fields: [{ name: 'provider', type: 'select', options: ['SANDBOX', 'SMTP', 'SES', 'TWILIO', 'META_WHATSAPP'], required: true }, { name: 'channel', type: 'select', options: ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'], required: true }, { name: 'ownership', type: 'select', options: ['WORKSPACE', 'PLATFORM'], required: true }, { name: 'credentialSecretRef', required: true, placeholder: 'env:NAME' }, { name: 'webhookSecretRef', placeholder: 'env:NAME' }] },
    { label: 'Health check', method: 'GET', path: '/marketing/providers/:providerId/health' },
    { label: 'Create sender', method: 'POST', path: '/marketing/senders', fields: [{ name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'displayName', required: true }, { name: 'address', required: true }, { name: 'providerConnectionId', required: true }] },
    { label: 'Verify sender', method: 'POST', path: '/marketing/senders/:senderId/verify', fields: [{ name: 'challenge', required: true }] },
    { label: 'Create template', method: 'POST', path: '/marketing/templates', fields: [{ name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'name', required: true }] },
    { label: 'New template version', method: 'POST', path: '/marketing/templates/:templateId/versions', fields: [{ name: 'subject' }, { name: 'bodyText', type: 'textarea', required: true }, { name: 'providerTemplate' }, { name: 'variableSchema', type: 'json' }] },
    { label: 'Approve template version', method: 'POST', path: '/marketing/templates/:templateId/versions/:version/approve' },
  ] },
  { title: 'Campaigns', list: { label: 'Campaigns', path: '/marketing/campaigns', contextKey: 'campaignId' }, actions: [
    { label: 'Create campaign', method: 'POST', path: '/marketing/campaigns', fields: [{ name: 'name', required: true }, { name: 'channel', required: true, defaultValue: 'EMAIL' }, { name: 'segmentId', required: true }, { name: 'senderIdentityId' }, { name: 'templateVersionId' }, { name: 'timezone', defaultValue: 'UTC' }] },
    { label: 'Audience & cost preview', method: 'POST', path: '/marketing/campaigns/:campaignId/preview' },
    { label: 'Submit for approval', method: 'POST', path: '/marketing/campaigns/:campaignId/submit-approval', fields: [version()] },
    { label: 'Approve / reject', method: 'POST', path: '/marketing/campaigns/:campaignId/approve', fields: [version(), { name: 'revision', type: 'number', required: true }, { name: 'decision', type: 'select', options: ['APPROVE', 'REJECT'] }, { name: 'reason' }] },
    { label: 'Schedule', method: 'POST', path: '/marketing/campaigns/:campaignId/schedule', fields: [version(), { name: 'approvedRevision', type: 'number', required: true }, { name: 'scheduledLocal', required: true, placeholder: '2026-11-01T09:00' }, { name: 'timezone', required: true }, { name: 'costAcknowledged', type: 'checkbox' }] },
    { label: 'Launch now', method: 'POST', path: '/marketing/campaigns/:campaignId/launch', fields: [version(), { name: 'approvedRevision', type: 'number', required: true }] },
    { label: 'Pause', method: 'POST', path: '/marketing/campaigns/:campaignId/pause' },
    { label: 'Resume', method: 'POST', path: '/marketing/campaigns/:campaignId/resume' },
    { label: 'Cancel', method: 'POST', path: '/marketing/campaigns/:campaignId/cancel', danger: true },
    { label: 'Test send', method: 'POST', path: '/marketing/campaigns/:campaignId/test-send', fields: [{ name: 'destination', required: true }] },
    { label: 'Deliveries', method: 'GET', path: '/marketing/campaigns/:campaignId/deliveries' },
    { label: 'Metrics', method: 'GET', path: '/marketing/campaigns/:campaignId/metrics' },
    { label: 'Retry failed deliveries', method: 'POST', path: '/marketing/campaigns/:campaignId/deliveries/retry-failed' },
  ] },
  { title: 'Growth', actions: [
    { label: 'Create A/B experiment', method: 'POST', path: '/marketing/campaigns/:campaignId/experiments', fields: [{ name: 'metric', type: 'select', options: ['OPEN', 'CLICK', 'CONVERSION', 'REPLY'], required: true }, { name: 'minSample', type: 'number', required: true, defaultValue: '100' }, { name: 'variants', type: 'json', required: true, placeholder: '[{"label":"A","templateVersionId":"…","percentage":50},{"label":"B","templateVersionId":"…","percentage":50}]' }] },
    { label: 'Experiment results', method: 'GET', path: '/marketing/campaigns/:campaignId/experiments/results' },
    { label: 'Create tracking link', method: 'POST', path: '/marketing/campaigns/:campaignId/tracking-links', fields: [{ name: 'destinationUrl', required: true }] },
    { label: 'Create journey (Workflow)', method: 'POST', path: '/marketing/journeys', fields: [{ name: 'name', required: true }, { name: 'workflowDefinitionId', required: true }, { name: 'reentryPolicy', type: 'select', options: ['PROHIBIT_ACTIVE', 'ALLOW'] }] },
    { label: 'Ad connection', method: 'POST', path: '/marketing/ad-connections', fields: [{ name: 'platform', type: 'select', options: ['META', 'GOOGLE'], required: true }, { name: 'credentialSecretRef', required: true }, { name: 'externalAccountId', required: true }, { name: 'sandbox', type: 'checkbox' }] },
    { label: 'Ad audience', method: 'POST', path: '/marketing/ad-audiences', fields: [{ name: 'connectionId', required: true }, { name: 'segmentId', required: true }] },
    { label: 'Sync ad audience', method: 'POST', path: '/marketing/ad-audiences/:audienceId/sync' },
    { label: 'Repeat-sale rule', method: 'POST', path: '/marketing/repeat-sales/rules', fields: [{ name: 'triggerEvent', type: 'select', options: ['ORDER_COMPLETED', 'ORDER_PAID', 'DEAL_WON'], required: true }, { name: 'segmentId', required: true }, { name: 'journeyId', required: true }] },
  ] },
];

/** HR & time tracking console (self-service + managers + HR administration). */
const hr: Section[] = [
  { title: 'My time', list: { label: 'My work sessions', path: '/hr/me/work-sessions', contextKey: 'workSessionId' }, actions: [
    { label: 'Clock in', method: 'POST', path: '/hr/me/clock-in', fields: [{ name: 'source', type: 'select', options: ['WEB', 'MOBILE'] }, { name: 'evidence', type: 'json', placeholder: 'Only where your work location requires it' }] },
    { label: 'Start break', method: 'POST', path: '/hr/me/break/start' },
    { label: 'End break', method: 'POST', path: '/hr/me/break/end' },
    { label: 'Clock out', method: 'POST', path: '/hr/me/clock-out' },
    { label: 'Request correction', method: 'POST', path: '/hr/attendance/corrections', fields: [{ name: 'employeeId', required: true }, { name: 'workSessionId' }, { name: 'targetDate', type: 'date' }, { name: 'proposedEvents', type: 'json', required: true, placeholder: '[{"type":"CLOCK_OUT","occurredAt":"2026-10-16T17:00:00+02:00"}]' }, reason] },
    { label: 'My leave balances', method: 'GET', path: '/hr/me/leave-balances' },
    { label: 'Request leave', method: 'POST', path: '/hr/leave/requests', fields: [{ name: 'leaveTypeId', required: true }, { name: 'fromLocal', type: 'date', required: true }, { name: 'toLocal', type: 'date', required: true }, { name: 'partDayMinutes', type: 'number' }, { name: 'reason', type: 'textarea' }] },
    { label: 'My leave requests', method: 'GET', path: '/hr/me/leave-requests' },
    { label: 'Work report', method: 'POST', path: '/hr/work-reports', fields: [{ name: 'periodType', type: 'select', options: ['DAY', 'WEEK', 'MONTH'], required: true }, { name: 'periodStart', type: 'date', required: true }, { name: 'periodEnd', type: 'date', required: true }, { name: 'summary', type: 'textarea', required: true }] },
  ] },
  { title: 'People', list: { label: 'Employees', path: '/hr/employees', contextKey: 'employeeId' }, actions: [
    { label: 'Create employee', method: 'POST', path: '/hr/employees', fields: [{ name: 'employeeNumber', required: true }, { name: 'displayName', required: true }, { name: 'userId' }, { name: 'departmentId' }, { name: 'managerEmployeeId' }, { name: 'timezone', required: true, defaultValue: 'Africa/Cairo' }, { name: 'startDate', type: 'date', required: true }, { name: 'privateData', type: 'json' }] },
    { label: 'Employee detail', method: 'GET', path: '/hr/employees/:employeeId' },
    { label: 'Activate', method: 'POST', path: '/hr/employees/:employeeId/activate', fields: [version()] },
    { label: 'Terminate', method: 'POST', path: '/hr/employees/:employeeId/terminate', fields: [version(), { name: 'endDate', type: 'date', required: true }, reason], danger: true },
    { label: 'Onboard', method: 'POST', path: '/hr/employees/:employeeId/onboard', fields: [{ name: 'effectiveDate', type: 'date', required: true }, { name: 'checklist', type: 'json' }, { name: 'taskIds', type: 'json' }] },
    { label: 'Offboard (revoke this workspace only)', method: 'POST', path: '/hr/employees/:employeeId/offboard', fields: [{ name: 'effectiveAt', type: 'datetime', required: true }, reason], danger: true },
    { label: 'Bind document', method: 'POST', path: '/hr/employees/:employeeId/documents/bind', fields: [{ name: 'fileId', required: true }, { name: 'category', type: 'select', options: ['CONTRACT', 'ID', 'CERTIFICATE', 'POLICY_ACK', 'MEDICAL', 'OTHER'], required: true }, { name: 'confidentiality', type: 'select', options: ['STANDARD', 'CONFIDENTIAL'], required: true }] },
    { label: 'Documents', method: 'GET', path: '/hr/employees/:employeeId/documents' },
  ] },
  { title: 'Schedules', list: { label: 'Schedules', path: '/hr/schedules', contextKey: 'scheduleId' }, actions: [
    { label: 'Create schedule', method: 'POST', path: '/hr/schedules', fields: [{ name: 'name', required: true }, { name: 'type', type: 'select', options: ['FIXED', 'FLEXIBLE', 'SHIFT'], required: true }, { name: 'timezone', required: true }] },
    { label: 'Publish version', method: 'POST', path: '/hr/schedules/:scheduleId/versions', fields: [{ name: 'effectiveFrom', type: 'date', required: true }, { name: 'rules', type: 'json', required: true, placeholder: '{"windows":{"1":[{"start":"09:00","end":"17:00"}]},"unpaidBreakMinutes":60,"restDays":[5,6]}' }] },
    { label: 'Assign to employee', method: 'POST', path: '/hr/employees/:employeeId/schedule-assignments', fields: [{ name: 'scheduleVersionId', required: true }, { name: 'effectiveFrom', type: 'date', required: true }] },
    { label: 'Expected workdays', method: 'GET', path: '/hr/employees/:employeeId/expected-workdays', query: [{ name: 'from', type: 'date', required: true }, { name: 'to', type: 'date', required: true }] },
    { label: 'Work location', method: 'POST', path: '/hr/work-locations', fields: [{ name: 'name', required: true }, { name: 'timezone', required: true }, { name: 'allowedNetworks', type: 'json' }, { name: 'geoRules', type: 'json' }, { name: 'qrRequired', type: 'checkbox' }] },
  ] },
  { title: 'Attendance', actions: [
    { label: 'Anomalies', method: 'GET', path: '/hr/attendance/anomalies' },
    { label: 'Corrections', method: 'GET', path: '/hr/attendance/corrections' },
    { label: 'Approve correction', method: 'POST', path: '/hr/attendance/corrections/:correctionId/approve', fields: [version(), { name: 'comment' }] },
    { label: 'Reject correction', method: 'POST', path: '/hr/attendance/corrections/:correctionId/reject', fields: [version(), { name: 'comment' }] },
    { label: 'Attendance', method: 'GET', path: '/hr/employees/:employeeId/attendance', query: [{ name: 'from', type: 'date', required: true }, { name: 'to', type: 'date', required: true }] },
  ] },
  { title: 'Timesheets', list: { label: 'Timesheets', path: '/hr/timesheets', contextKey: 'timesheetId' }, actions: [
    { label: 'Compile', method: 'POST', path: '/hr/timesheets/compile', fields: [{ name: 'employeeId' }, { name: 'periodStart', type: 'date', required: true }, { name: 'periodEnd', type: 'date', required: true }] },
    ...(['submit', 'approve', 'reject', 'lock'] as const).map(step => ({ label: step[0].toUpperCase() + step.slice(1), method: 'POST' as const, path: '/hr/timesheets/:timesheetId/' + step, fields: [version(), { name: 'comment' }] })),
    { label: 'Reopen (HR)', method: 'POST', path: '/hr/timesheets/:timesheetId/reopen', fields: [version(), reason] },
    { label: 'Overtime policy', method: 'POST', path: '/hr/overtime/policies', fields: [{ name: 'thresholds', type: 'json', required: true, placeholder: '{"dailyMinutes":480,"weeklyMinutes":2400}' }, { name: 'eligibleEmploymentTypes', type: 'json', required: true, defaultValue: '["FULL_TIME"]' }, { name: 'effectiveFrom', type: 'date', required: true }] },
    { label: 'Recalculate overtime', method: 'POST', path: '/hr/overtime/recalculate', fields: [{ name: 'employeeId', required: true }, { name: 'from', type: 'date', required: true }, { name: 'to', type: 'date', required: true }] },
  ] },
  { title: 'Leave', actions: [
    { label: 'Leave type', method: 'POST', path: '/hr/leave/types', fields: [{ name: 'name', required: true }, { name: 'unit', type: 'select', options: ['DAY', 'HOUR'], required: true }, { name: 'paid', type: 'checkbox' }, { name: 'requiresBalance', type: 'checkbox' }, { name: 'approvalChain', type: 'json', defaultValue: '["MANAGER"]' }] },
    { label: 'Leave policy', method: 'POST', path: '/hr/leave/policies', fields: [{ name: 'leaveTypeId', required: true }, { name: 'accrualRule', type: 'json', required: true, defaultValue: '{"frequency":"MONTHLY","units":"1.75"}' }, { name: 'carryOverRule', type: 'json', required: true, defaultValue: '{"maxUnits":"5"}' }, { name: 'holidays', type: 'json' }, { name: 'effectiveFrom', type: 'date', required: true }] },
    { label: 'Adjust balance', method: 'POST', path: '/hr/leave/balances/adjust', fields: [{ name: 'employeeId', required: true }, { name: 'leaveTypeId', required: true }, { name: 'period', required: true }, { name: 'units', required: true }, { name: 'kind', type: 'select', options: ['ALLOCATION', 'ADJUSTMENT'], required: true }, { name: 'note', required: true }] },
    { label: 'Approve leave', method: 'POST', path: '/hr/leave/requests/:leaveRequestId/approve', fields: [version(), { name: 'comment' }] },
    { label: 'Reject leave', method: 'POST', path: '/hr/leave/requests/:leaveRequestId/reject', fields: [version(), { name: 'comment' }] },
    { label: 'Absence calendar (free/busy only)', method: 'GET', path: '/hr/absences/calendar', query: [{ name: 'from', type: 'date', required: true }, { name: 'to', type: 'date', required: true }] },
  ] },
  { title: 'Reports & privacy', actions: [
    ...(['attendance', 'leave', 'headcount', 'overtime'] as const).map(kind => ({ label: 'Report: ' + kind, method: 'GET' as const, path: '/hr/reports/' + kind, query: [{ name: 'from', type: 'date' as const }, { name: 'to', type: 'date' as const }, { name: 'groupBy', type: 'select' as const, options: ['DEPARTMENT', 'EMPLOYEE'] }] })),
    { label: 'Retention status', method: 'GET', path: '/hr/privacy/retention-status' },
    { label: 'Retention policy', method: 'POST', path: '/hr/privacy/retention-policies', fields: [{ name: 'jurisdiction', required: true }, { name: 'category', type: 'select', options: ['ATTENDANCE_EVIDENCE', 'WORK_EVENTS', 'LEAVE', 'DOCUMENTS', 'PROFILE'], required: true }, { name: 'retentionDays', type: 'number', required: true }, { name: 'effectiveFrom', type: 'date', required: true }, { name: 'legalBasis', required: true }, { name: 'disposalMethod', type: 'select', options: ['DELETE', 'ANONYMIZE'], required: true }] },
    { label: 'Legal hold', method: 'POST', path: '/hr/privacy/legal-holds', fields: [{ name: 'employeeId' }, reason] },
  ] },
];

/** Sites & landing pages console. */
const sites: Section[] = [
  { title: 'Sites', list: { label: 'Sites', path: '/sites', contextKey: 'siteId' }, actions: [
    { label: 'Create site', method: 'POST', path: '/sites', fields: [{ name: 'name', required: true }, { name: 'type', type: 'select', options: ['SITE', 'LANDING', 'STORE'], required: true }, { name: 'subdomain', required: true }, { name: 'defaultLocale', required: true, defaultValue: 'en' }, { name: 'requiresApproval', type: 'checkbox' }] },
    { label: 'Hosting status', method: 'GET', path: '/sites/:siteId/hosting-status' },
    { label: 'Add custom domain', method: 'POST', path: '/sites/:siteId/domains', fields: [{ name: 'hostname', required: true }, { name: 'isPrimary', type: 'checkbox' }], describe: 'Publish the returned TXT record, then verify.' },
    { label: 'Verify domain', method: 'POST', path: '/sites/domains/:domainId/verify' },
    { label: 'Create from template', method: 'POST', path: '/sites/:siteId/from-template', fields: [{ name: 'templateKey', type: 'select', options: ['LANDING_BASIC', 'COMPANY_SITE'], required: true }] },
    { label: 'Export (no secrets)', method: 'POST', path: '/sites/:siteId/export' },
    { label: 'Entitlement impact', method: 'GET', path: '/sites/:siteId/entitlement-impact' },
  ] },
  { title: 'Content', list: { label: 'Pages', path: '/sites/:siteId/pages', contextKey: 'pageId' }, actions: [
    { label: 'Create page', method: 'POST', path: '/sites/:siteId/pages', fields: [{ name: 'slug', placeholder: 'about (empty for home)' }, { name: 'title', required: true }, { name: 'locale' }, { name: 'blockTreeJson', type: 'json', placeholder: '{"blocks":[{"type":"headline","text":"Hello"}]}' }] },
    { label: 'Save draft revision', method: 'POST', path: '/sites/pages/:pageId/revisions', fields: [{ name: 'blockTreeJson', type: 'json', required: true }, { name: 'expectedDraftRevision', type: 'number' }] },
    { label: 'Page SEO', method: 'PUT', path: '/sites/pages/:pageId/seo', fields: [{ name: 'title', required: true }, { name: 'metaDescription' }, { name: 'indexability', type: 'select', options: ['INDEX', 'NOINDEX'] }] },
    { label: 'Navigation menu', method: 'POST', path: '/sites/:siteId/navigation', fields: [{ name: 'name', required: true, defaultValue: 'main' }, { name: 'locale', required: true, defaultValue: 'en' }, { name: 'items', type: 'json', required: true, placeholder: '[{"label":"About","pageId":"…"}]' }] },
    { label: 'Redirects', method: 'PUT', path: '/sites/:siteId/redirects', fields: [{ name: 'redirects', type: 'json', required: true, placeholder: '[{"fromPath":"/old","toPath":"/new","statusCode":301}]' }] },
    { label: 'Shared block', method: 'POST', path: '/sites/shared-blocks', fields: [{ name: 'name', required: true }, { name: 'kind', required: true, defaultValue: 'headline' }, { name: 'ownerSiteId' }, { name: 'propsJson', type: 'json', required: true }] },
    { label: 'Theme', method: 'POST', path: '/sites/:siteId/theme', fields: [{ name: 'tokens', type: 'json', required: true, defaultValue: '{"primaryColor":"#1e688d","textColor":"#192b3f","backgroundColor":"#ffffff","fontFamily":"system","radius":"md"}' }, { name: 'breakpoints', type: 'json', required: true, defaultValue: '{"mobile":480,"tablet":900,"desktop":1280}' }] },
    { label: 'Archive page', method: 'POST', path: '/sites/pages/:pageId/archive', fields: [reason, { name: 'redirectTo' }], danger: true },
  ] },
  { title: 'Publishing', list: { label: 'Releases', path: '/sites/:siteId/releases', contextKey: 'releaseId' }, actions: [
    { label: 'Compile release candidate', method: 'POST', path: '/sites/:siteId/releases/preview' },
    { label: 'Preview link', method: 'POST', path: '/sites/:siteId/preview-links', fields: [{ name: 'releaseId', required: true }, { name: 'expiresInMinutes', type: 'number', required: true, defaultValue: '60' }, { name: 'password' }] },
    { label: 'Approve release', method: 'POST', path: '/sites/:siteId/releases/:releaseId/approve', fields: [{ name: 'decision', type: 'select', options: ['APPROVE', 'REJECT'] }] },
    { label: 'Publish release', method: 'POST', path: '/sites/:siteId/releases/publish', fields: [{ name: 'releaseId', required: true }, { name: 'expectedSiteVersion', type: 'number', required: true }] },
    { label: 'Schedule release', method: 'POST', path: '/sites/:siteId/releases/schedule', fields: [{ name: 'releaseId', required: true }, { name: 'scheduledAt', type: 'datetime', required: true }, { name: 'timezone', required: true }] },
    { label: 'Rollback to release', method: 'POST', path: '/sites/:siteId/releases/:releaseId/rollback', danger: true },
  ] },
  { title: 'Experience', actions: [
    { label: 'Add language', method: 'POST', path: '/sites/:siteId/languages', fields: [{ name: 'locale', required: true }, { name: 'fallbackPolicy', type: 'select', options: ['DEFAULT_LANGUAGE', 'NOT_FOUND'] }, { name: 'enabled', type: 'checkbox' }] },
    { label: 'Translate page', method: 'POST', path: '/sites/pages/:pageId/translations', fields: [{ name: 'targetLocale', required: true }, { name: 'useAi', type: 'checkbox' }] },
    { label: 'Localization coverage', method: 'GET', path: '/sites/:siteId/localization-coverage' },
    { label: 'Site SEO', method: 'PATCH', path: '/sites/:siteId/seo', fields: [{ name: 'robotsDefault', type: 'select', options: ['index,follow', 'noindex,nofollow', 'index,nofollow'] }, { name: 'sitemapEnabled', type: 'checkbox', defaultValue: 'true' }] },
    { label: 'Bind module (form/product/checkout)', method: 'POST', path: '/sites/pages/:pageId/module-bindings', fields: [{ name: 'blockKey', required: true }, { name: 'module', type: 'select', options: ['FORM', 'CONTACT_WIDGET', 'PRODUCT', 'CART', 'CHECKOUT'], required: true }, { name: 'externalResourceId', required: true }] },
    { label: 'Module readiness', method: 'GET', path: '/sites/:siteId/module-readiness' },
    { label: 'Cookie policy', method: 'PUT', path: '/sites/:siteId/cookie-policy', fields: [{ name: 'categories', type: 'json', required: true, defaultValue: '[{"key":"NECESSARY","description":"Required","isOptional":false},{"key":"ANALYTICS","description":"Statistics","isOptional":true}]' }] },
    { label: 'Submit script for review', method: 'POST', path: '/sites/:siteId/scripts', fields: [{ name: 'kind', type: 'select', options: ['INTEGRATION', 'CUSTOM'], required: true }, { name: 'language', type: 'select', options: ['CSS', 'JS'], required: true }, { name: 'source', type: 'textarea', required: true }, { name: 'allowedCategory', type: 'select', options: ['NECESSARY', 'ANALYTICS', 'MARKETING', 'CUSTOM'], required: true }] },
    { label: 'Review script', method: 'POST', path: '/sites/scripts/:scriptId/approve', fields: [{ name: 'decision', type: 'select', options: ['APPROVE', 'REJECT', 'REVOKE'], required: true }] },
    { label: 'Security preview (CSP)', method: 'GET', path: '/sites/:siteId/security-preview' },
    { label: 'A/B experiment', method: 'POST', path: '/sites/pages/:pageId/experiments', fields: [{ name: 'metric', type: 'select', options: ['CONVERSION_RATE', 'CLICK_RATE'], required: true }, { name: 'goalEvent', required: true }, { name: 'variants', type: 'json', required: true, placeholder: '[{"label":"A","pageRevisionId":"…","trafficPercent":50},{"label":"B","pageRevisionId":"…","trafficPercent":50}]' }] },
    { label: 'AI draft (never published automatically)', method: 'POST', path: '/sites/:siteId/ai/generate', fields: [{ name: 'brief', type: 'textarea', required: true }, { name: 'scenario', type: 'select', options: ['LANDING_PAGE', 'SECTION'] }, { name: 'requestKey', required: true, defaultValue: 'req-' + Date.now() }] },
  ] },
];

export const CommerceConsole = () => <Console product="Online Store" storageKey="suite-commerce-session" sections={commerce} />;
export const MarketingConsole = () => <Console product="Marketing" storageKey="suite-marketing-session" sections={marketing} />;
export const HrConsole = () => <Console product="HR & Time" storageKey="suite-hr-session" sections={hr} />;
export const SitesConsole = () => <Console product="Sites" storageKey="suite-sites-session" sections={sites} />;
