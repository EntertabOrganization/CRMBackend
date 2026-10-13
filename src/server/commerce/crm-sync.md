# Order CRM synchronization

Checkout queues one durable CRM sync intent in the Order transaction. It pins the Store Deal policy and does not execute CRM writes during public checkout. `MANUAL_REVIEW` remains held until an employee with Order management and customer management permissions requests sync.

`POST /api/v1/commerce/orders/:orderId/crm-sync` accepts `{}` and an `Idempotency-Key` of 8–128 characters and returns HTTP 202 with `syncId`, `orderId`, `status`, and `dealPolicy`. Request identities are permanent. A replay returns the original response; a new key can restart an exhausted failure without changing the pinned policy or creating a second Deal.

The worker resolves the current configured `settings.crmPrincipalUserId` for automatic work, or the requesting employee for manual work. It rechecks Workspace membership, Store/Order scope, explicit CRM grants, stage access, and owning field requirements. Missing configuration or revoked access records a sanitized retry error and leaves the Order intact. Five failures exhaust a cycle; expired claims are recoverable and live claims are fenced.

CRM owns all Contact, Company and Deal mutations. Exact email/phone identities follow shared merge redirects. Multiple identities, inaccessible matches, or conflicting existing bindings require review; the worker never auto-merges or matches by name. PERSON resolves a Contact and COMPANY resolves a Company. `NEVER` skips Deal creation; `ONLY_NEW_CUSTOMER` creates a Deal only when this transaction creates the customer; `ALWAYS` and approved `MANUAL_REVIEW` create at most one Deal per Order.

CRM mutations, bindings, completion history, and the `ORDER_CRM_LINKED` event commit together. Failed attempts roll back partial customer/Deal writes. Order snapshots and monetary truth remain unchanged. The legacy CRM floating-point amount is left null; the Deal contains the immutable Commerce Order origin reference and currency instead.

Order integrations expose the sync status, pinned policy, attempts, outcome and sanitized error code. They omit principal identifiers, leases, raw exceptions and customer PII. Reconciliation uses the pinned policy for existing sync jobs.
