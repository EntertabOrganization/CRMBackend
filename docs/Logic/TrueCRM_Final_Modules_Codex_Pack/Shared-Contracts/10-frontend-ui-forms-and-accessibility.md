# Frontend routes and interaction contracts

Next.js frontend uses repository route structure, typed API client and query cache with Workspace/Partner keys; invalidate caches on switch, revocation and entitlement version changes. No navigation artifact grants permission.

## Required surface groups

- Knowledge: `/knowledge/spaces`, nested tree/articles/editor/revisions/shares/reviews/acknowledgments/trash/search/import, separate draft/published visual indicator.
- AI: `/ai/assistants`, conversation runner, scenario/model settings, sources/citations, pending tool-approval screen with immutable args preview, usage and BYOK configuration, external connection revocation.
- Platform: Notifications inbox/preferences, authorized operations dashboards (queue/DLQ/search health), audit viewer, feature settings, support grant and privacy/legal-hold controls.
- Billing: Workspace subscription/plan quote/trial/cancel/change, invoices/payments, usage and credit history, top-up checkout, recovery; Platform plan/catalog/reconciliation management.
- Partner: Public become-a-partner; Platform application reviews, discount management, relations, payouts; Partner team/membership, referral links, delegated customer workspaces, commission dashboard; Customer Workspace owner delegation controls.

All forms validate server and client; use keyboard-accessible labels/visible focus, loading skeletons, error/banner with stable code and recovery action, optimistic concurrency 409 UI, confirmation for destructive/high-impact commands, and accessible status announcements for queued operations. RTL/locales and dates/currencies honor user/workspace preferences. Never show unavailable action as authorized based solely on client role check. Avoid hard-coded Bitrix24 branding or imitation; use repository design system.
