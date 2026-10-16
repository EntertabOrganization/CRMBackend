# 30-Platform-Services — module map

Outbox, jobs, notifications, realtime, search, auditing, settings, rate limiting, retention and operations.

## Read order

First `../Agent.md`, all `../Shared-Contracts`, then these specs in numbered order:

- [`01-outbox-and-domain-event-contract.md`](01-outbox-and-domain-event-contract.md) — Transactional outbox and shared event transport (Core V1).
- [`02-jobs-scheduler-and-retries.md`](02-jobs-scheduler-and-retries.md) — Durable jobs, schedules, retries and dead-letter handling (Core V1).
- [`03-notifications-preferences-and-delivery.md`](03-notifications-preferences-and-delivery.md) — Notifications, preferences, mandatory notices (Core V1).
- [`04-realtime-and-presence.md`](04-realtime-and-presence.md) — Realtime gateway, cache invalidation and presence (Core V1).
- [`05-global-search-recents-and-favorites.md`](05-global-search-recents-and-favorites.md) — ACL-safe global search and derived personal views (Core V1).
- [`06-audit-security-history-and-support-access.md`](06-audit-security-history-and-support-access.md) — Immutable audit, security events and support access (Core V1).
- [`07-platform-settings-flags-locale-and-numbering.md`](07-platform-settings-flags-locale-and-numbering.md) — Platform settings, feature flags, localization and numbering (Core V1).
- [`08-rate-limits-idempotency-and-caching.md`](08-rate-limits-idempotency-and-caching.md) — Rate limits, idempotency records and safe caching (Core V1).
- [`09-retention-portability-and-legal-holds.md`](09-retention-portability-and-legal-holds.md) — Retention engine, portability and privacy workflows (Core V1).
- [`10-observability-backups-and-recovery.md`](10-observability-backups-and-recovery.md) — Health, observability, backups and disaster recovery (Core V1).

Tests: `../Testing/30-Platform-Services`. Dependencies crossing module boundaries are in the contracts, not owned tables.
