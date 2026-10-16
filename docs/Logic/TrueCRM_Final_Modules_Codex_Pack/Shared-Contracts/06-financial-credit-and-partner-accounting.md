# Money, quotas, Partner discounts and commissions

## Decimal conventions

Use database NUMERIC and decimal library; basis-point rate integer `0..10000`. Percent `10% -> 1000` basis points; `20% -> 2000`. For each line compute `discountAmount = ROUND_HALF_UP(baseAmount * bps / 10000, currencyMinorUnit)` and `netLine = baseAmount - discountAmount`. Record `calculation_version`, currency, input and rounded output on immutable quote. No JavaScript `Number` for persisted financial arithmetic. Currency minor-unit per ISO 4217 unless legal policy overrides.

## Discount precedence and ownership

Partner owns default/product/category rule and version. Resolve product-specific > most-specific category > default. Billing computes immutable quote with relation identity, rule version, payer, beneficiary Workspace and invoice owner; edits to Partner rule never rewrite history. Referrals/commissions are **not** automatic discounts; they are separate economics.

## Credit consumption

1. Billing atomically determines eligible credit grants and plan entitlement.
2. Reserve plan-included grants by earliest expiration then purchased grants by earliest expiration; ties by grant ID.
3. On completion settle actual usage and release remainder; on cancellation/failure release only unused portion; retain cost evidence for any consumed provider work.
4. Expiry and reversal append ledger entries. Grant activation after trusted payment; no negative balance by default. Every operation has `eventKey` dedup.
5. BYOK usage still counted for workspace caps/analytics but not debited from platform-managed credits if BYOK policy says so.

## Commissions and payouts

Eligible settled customer revenue -> Partner policy snapshot -> commission accrual (fixed or bps) -> hold/approve -> payout batch -> finance approval -> externally verified/manual payment evidence -> reconcile -> mark paid. Refund/chargeback causes compensating reversal, including after prior payout (record liability/offset, don't rewrite paid history). One active Partner relation per beneficiary Workspace; old historical sales retain original Partner ID after transfer.

## Payer and beneficiary

`payer_account_id` may belong to customer or Partner. `beneficiary_workspace_id` is always the real customer tenant. Payer liability doesn't grant tenant ownership or access. Partner payment failure follows ordinary recovery and may trigger approved payer transition; it cannot delete/transfer customer Workspace.
