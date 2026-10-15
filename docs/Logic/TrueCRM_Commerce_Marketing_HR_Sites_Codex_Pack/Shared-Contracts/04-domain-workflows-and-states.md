# Cross-module state machine contracts

## Commerce orchestration

1. Resolve ACTIVE Store and verified public/customer session -> validate Cart ACTIVE -> quote against Catalog/Promotion/Tax/Delivery.
2. On confirm with unique key: lock checkout/cart; validate price/availability; reserve stock through Inventory service; persist Order with immutable lines, initial `PENDING_PAYMENT`; outbox event in committed transaction. If an external boundary cannot commit atomically, use saga with compensating reservation release and idempotent retry.
3. Payment provider attempt belongs to commercial payment services. Verified provider state changes payment projection `UNPAID/PARTIAL/PAID` and drives order confirmation. Browser success redirect is nonauthoritative.
4. Late captured payment + reservation expiry => preserve payment, mark fulfillment exception, attempt new allocation if policy permits, otherwise authorized backorder/refund path; never drop financial record.
5. Shipment dispatch issues Inventory movement and consumes reserved units; partial shipments retain remaining quantities; return inspected separately; restock only on explicit approved disposition; refunds are independent payment records.

## Marketing delivery

`Campaign DRAFT -> IN_REVIEW -> APPROVED -> SCHEDULED -> RUNNING -> COMPLETED` with `PAUSED`, `CANCELLED`, `FAILED`. Approved revision + frozen audience snapshot immutable after launch. Per-recipient pipeline: `TARGETED -> ELIGIBLE|INELIGIBLE -> QUEUED -> SENDING -> ACCEPTED -> DELIVERED|BOUNCED|FAILED` with allowed late provider updates. Consent/suppression checked again on dequeue. Pause does not retract accepted provider requests; retries are bounded, same-channel only, idempotent by delivery ID.

## HR worktime and leave

`WorkSession OPEN -> CLOSED|INCOMPLETE` and corrections use `REQUESTED -> APPROVED -> APPLIED` without raw event modification. `Timesheet DRAFT -> SUBMITTED -> APPROVED -> LOCKED`; reopen audited before edits. `LeaveRequest DRAFT -> SUBMITTED -> APPROVED|REJECTED|CANCELLED`; submit places leave balance HOLD, approval converts to DEBIT, rejection/cancellation releases. Supervisor/HR authority checked at decision time.

## Sites public publishing

Draft updates always create new PageRevision; shared-block revisions and navigation/SEO are pinned in SiteRelease manifest. Publish must validate approvals/links, build release and atomically activate. Public cache keyed by active release. Failure leaves prior active release. Rollback activates prior manifest as new audited operation. Scheduled activation uses idempotent job. Preview access does not entail public publication.

## Cross-module failure semantics

Order -> CRM link, Site Form -> Forms, Marketing -> attribution projection, HR Leave -> Calendar, and Sites release -> CDN invalidation may fail after primary commit. Store durable integration status and idempotent retry with dead-letter/alert. Never rewrite or silently compensate an already confirmed provider charge or legally recorded work event as if it never occurred.
