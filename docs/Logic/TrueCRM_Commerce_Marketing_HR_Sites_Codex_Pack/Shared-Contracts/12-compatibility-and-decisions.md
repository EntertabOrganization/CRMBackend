# Decision precedence, compatibility and no-hidden-assumption registry

Priority: user latest explicit decisions > previously confirmed decisions > TrueCRM BRD/PRD/System Architecture > repository behavior > reference ZIP structural conventions > implementation defaults. Structural philosophy from reference Auth pack does NOT import its Auth-specific constraints (exactly one role, no standard timestamps, partner logic, or PR conventions).

**Approved stack:** Next.js/TypeScript, NestJS modular monolith, PostgreSQL, Redis, S3-compatible object storage, workers, WebSocket/SSE when needed. Reuse ORM already selected in repository; reference ZIP happens to use Prisma but it is not a locked TrueCRM source requirement.

**Resolved differences:** Bitrix24 currently routes online-store transactions through Deals in some flows; TrueCRM has separate Order entity and optional Deal link. Bitrix24 may allow auto-publication; TrueCRM defaults to separate draft/published release and explicit controlled publish. Privacy/consent/retention features follow confirmed TrueCRM decisions even if they differ from Bitrix24 UI behavior.

**Configuration-required, not unanswered product decisions:** Store tax categories, applicable country/currency table, delivery carrier credentials, order reservation TTL (value per store, not global assumption), return period, jurisdiction law applicability, employee accrual thresholds, workplace holiday calendar, overtime thresholds, marketing quiet hours/rate caps and sender accounts must be configured by each tenant before respective features become ACTIVE. Missing required configuration yields `POLICY_NOT_CONFIGURED`. The 15-day initial grace period is a confirmed global configurable default.

**Repo conditional conventions:** For an absent endpoint/column naming convention, follow `Shared-Contracts/01-api-and-query-conventions.md`, UUID + snake_case DB and camelCase TypeScript as implementation recommendation. If production source contradicts confirmed business policy, stop that module and record explicit conflict, do not quietly flip product behavior.
