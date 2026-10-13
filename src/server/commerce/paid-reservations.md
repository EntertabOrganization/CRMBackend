# Reservations after full payment

A stockable Store can select `reservationTiming: PAYMENT_PAID`. Activation requires a configured current Inventory principal with Order view, Inventory reservation creation, payment read, and appropriate Warehouse access. Checkout pins this timing in one durable Order job, initially `WAITING`. It does not reserve stock or claim provider settlement. Backend-priced zero-total Orders start with `PAID` coverage and queue immediately because no financial settlement is required; no Payment record or capture is fabricated.

The shared Payment coverage calculation queues that job only when net settled, same-currency Order allocations cover the total. Pending authorization, partial payment, and browser redirects do not queue stock effects. Job and queue evidence commit with the confirmed Order payment projection. Provider settlement never depends on subsequent Inventory success.

The dedicated worker claims a 60-second database lease, rechecks current Workspace/Order/Inventory/Warehouse/payment access, and recalculates net settled coverage. Loss of payment coverage returns the job to `WAITING`. Closed or archived Orders cannot reserve. Reservation commands, exact Order-line bindings, job completion, history, audit and outbox commit atomically. Competing workers are fenced by the claim token; expired leases recover; terminal jobs cannot replay. Failures roll back partial stock effects and retry with backoff, exhausting after five attempts. An exhausted failure requires a controlled administrative recovery flow, which remains outstanding.

The configured Store timing may change for future Orders without reinterpreting an existing payment-paid job. Its configured Inventory principal and Warehouse authority are rechecked when it runs. Shipment allocation uses the persisted line bindings. Inventory source quantities and monetary records remain owned by their respective services.

Order integrations expose only job identity, correlation ID, policy, state, attempt count and sanitized error code. They omit claim tokens, lease fields, principal identifiers and raw failures. Reconciliation reports pending/failed stock jobs and validates succeeded reservations against current stock and remaining Order quantities.

`CART`, `PAYMENT_AUTHORIZED`, `MANUAL`, and legacy ambiguous-line recovery remain separate unfinished tasks. Only `ORDER_PLACED` and `PAYMENT_PAID` are enabled for stockable Store activation and checkout.
