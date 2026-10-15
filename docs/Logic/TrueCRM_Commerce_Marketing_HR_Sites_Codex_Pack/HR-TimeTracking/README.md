# HR-TimeTracking — module map

Core V1: profiles, effective-dated schedules, work sessions/breaks, attendance corrections, timesheets, leave and HR permissions; Advanced: configurable overtime, work reports, expanded lifecycle templates, HR analytics.

**Core invariant:** EmployeeProfile != global User; attendance != Task time; finalized time evidence and approvals must be historical and auditable.

## Submodule specifications

- [`01-employee-profiles.md`](01-employee-profiles.md) — Maintain workspace-scoped employee work records separately from global authentication identity.
- [`02-work-schedules-and-shifts.md`](02-work-schedules-and-shifts.md) — Resolve expected employee work periods across fixed, flexible and shift patterns with timezone/DST correctness.
- [`03-clock-and-breaks.md`](03-clock-and-breaks.md) — Record real employee attendance events, including optional network/GPS/QR evidence only at policy-required points.
- [`04-attendance-and-corrections.md`](04-attendance-and-corrections.md) — Compare actual work to expected schedules without deleting historical events.
- [`05-timesheets.md`](05-timesheets.md) — Summarize work sessions into reviewable time periods and preserve final approved records.
- [`06-overtime-policy.md`](06-overtime-policy.md) — Calculate and approve overtime from configured threshold policies without building payroll.
- [`07-leave-types-balances.md`](07-leave-types-balances.md) — Manage policy-versioned leave balances, carry-over, prorating and optional negative-balance overrides.
- [`08-leave-requests-and-approvals.md`](08-leave-requests-and-approvals.md) — Run configurable leave/absence approval flows without exposing private absence reasons to general calendars.
- [`09-work-reports.md`](09-work-reports.md) — Collect qualitative work reports and manager comments without modifying attendance or Task hours.
- [`10-onboarding-offboarding-and-docs.md`](10-onboarding-offboarding-and-docs.md) — Coordinate employee entry/exit using shared Tasks, Files, Workflows and Membership services.
- [`11-hr-security-retention-and-analytics.md`](11-hr-security-retention-and-analytics.md) — Make HR data access privacy-first with auditable reports and jurisdiction-configured retention.

## External owner boundaries

Own only records declared in the above specs. Other domains must be accessed through narrow typed service contracts, not direct table writes.

## Activation readiness / configuration

- Authenticated workspace membership/permissions and active entitlement must be resolved.
- Applicable locale/jurisdiction, tax, HR, consent and retention policies must be configured before enabling their corresponding operations.
- Any external provider needed for production operation must have a verified identity, separate secret and observable health state.
- Missing operational dependency must be surfaced as a blocker, never auto-created as a second source of truth.

## Tests

Every file above maps to `Testing/HR-TimeTracking/<same-slug>.spec.ts`; module E2E in `Testing/HR-TimeTracking/HR-TimeTracking.e2e-spec.ts`. See `Testing/README.md`.
