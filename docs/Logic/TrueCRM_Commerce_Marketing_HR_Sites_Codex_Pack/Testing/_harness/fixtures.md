# Required repository-specific test fixtures and evidence

Use an isolated migrated PostgreSQL test database with seeded Workspace A/Workspace B. A has Owner/Admin, restricted Employee, scoped Manager, HR, Publisher, Marketer, linked Storefront Customer, Guest and linked CRM records. B contains *different* Store/Order/Employee/Site IDs used in cross-tenant attacks. Dates include time-zone and DST edge cases. Seed real data through services or explicitly safe test seeders, never by bypassing required invariants in application tests.

The `RepositoryHarness` in `adapter.ts` provides `seed(name)` => `{workspaceId, otherWorkspaceId, ids, tokens, publicHost}`, `request` => a real authenticated or public HTTP call (Supertest is suitable), `observe` => a direct **read-only** DB/provider-fake inspection of source rows and outbox, and optional `runContractCase` => documented real arrange/act/assert with evidence. Fixture scenarios required by the included E2E suites:

- `commerce_checkout`: active Store/catalog item + 2 available stock units + signed guest cart/checkout session ready for confirm; ids `checkoutSessionId`, `cartId`, `variantId`, `foreignOrderId`, `pendingOrderId`, `paymentWebhookConnection`, `orderId`, `shipmentId`, `returnId` when referenced.
- `marketing_campaign`: Campaign DRAFT/APPROVED (fixture metadata), frozen segment containing a recipient whose consent can be withdrawn; ids `campaignId`, `recipientKey`, `foreignSegmentId`, `senderId`, `templateId`, `providerConnectionId`.
- `hr_attendance`: employee and scoped supervisor and work session ready for clock/correction, approved Timesheet fixture and Leave balance single day; ids `employeeId`, `workSessionId`, `lockedTimesheetId`, `leaveTypeId`, `foreignEmployeeId`, `leaveRequestId`.
- `sites_publication`: verified domain and Site with active release and newer unpublished draft, external actor without publish, expiring preview token, live shared-block binding and commerce block; ids `siteId`, `pageId`, `releaseId`, `draftReleaseId`, `foreignSiteId`, `sharedBlockId`, `previewToken`.

Additional per-file cases are identified as `<Module>/<spec-file>::AC01` etc. The coding agent must implement fixture-specific arrangers matching that spec and return tangible measured evidence (request ID, database queries, observed audit/outbox IDs). If a fixture is impossible because its production dependency is absent, test fails with a genuine dependency blocker.

Never replace `observe` with an in-memory fake of the platform source of truth; deterministic *provider fakes* are allowed and must record calls. Tests must inspect actual database transaction results and outbox rows. Secrets/test card numbers must use provider-recommended sandbox tokens, never real customer PII.
