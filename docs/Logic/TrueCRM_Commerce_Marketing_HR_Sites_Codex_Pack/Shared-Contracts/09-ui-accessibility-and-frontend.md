# Frontend UI and accessibility contract

Frontend is Next.js + TypeScript, component patterns discovered from repository. Server-authoritative validation must be duplicated client-side for UX only, never substituted for backend checks.

## Required pages and states

- Commerce admin: store list/settings/readiness, published catalog, discount/tax/delivery settings, orders/detail/history, payments, fulfillment, returns, reports. Public storefront: searchable catalog/product detail, cart, checkout, order confirmation/pending/failed; optional customer portal with orders/tracking/returns.
- Marketing: segment list/builder/preview/import results, sender/provider setup, template editor/version preview/test, campaign wizard/approval/schedule, send monitor, suppression/consent manager, experiments/journeys, engagement/ads reporting.
- HR: scoped employee directory/profile, manager/schedule planner/shift assignment, clock/break widget, personal worktime, anomalies/correction inbox, timesheet period/submission/approval, leave balance/calendar/request, confidential document area, work reports, lifecycle checklist and reports.
- Sites: site dashboard/templates, domain readiness, navigation/pages/content, visual block editor, responsive breakpoints, shared blocks, localization, preview link/publish approval/release history/rollback, SEO/privacy/scripts, experiment/AI draft screens.

## UX contract

For every operation implement loading/empty/error/no-permission states and optimistic edit rollback; expose status and retry reason for asynchronous jobs. Confirmation modals for destructive/financial/public-publish/bulk-send actions include impact text. Server validation errors map to field paths; aria-live messages for async state. Mobile responsiveness for public checkout and site pages. Keyboard-accessible controls; focus management, logical heading structure, form labels and non-color-only status. RTL support in public Sites and key admin controls where chosen locale requires it. Date/time UI always shows named timezone for HR schedules and campaigns. Charts and reports provide accessible tabular counterpart and export only with explicit permission.

Privacy: internal UI never exposes HR sensitive fields or merchant credentials via preloaded Next.js props/SSR caches; public page bundle contains only published release and public adapter config.
