# Product Tax Defaults

## Scope

Catalog stores Product/Variant default tax configuration/reference used when constructing a new commercial Product Row.

The final authoritative tax calculation on an Estimate/Invoice/Order may be owned by the relevant commercial domain and jurisdiction policy. Catalog provides defaults, not historical truth.

## Master configuration

Support repository-equivalent values such as:

- taxable / not taxable;
- tax rate reference or validated default rate;
- tax included/excluded default if the platform allows both;
- optional tax category/code for future tax engines.

Prefer references to a shared Tax Rate/Tax configuration service if it exists rather than duplicating tax master data.

## Row snapshot

When a Product is added to a commercial owner, snapshot at least the values required to reproduce totals:

- taxable flag;
- resolved tax rate;
- tax included/excluded mode;
- tax amount or calculation components as defined by CommercialValueService;
- subtotal/total.

Later Product tax changes must not rewrite historical rows.

## Server calculation

Client-provided totals are never authoritative.

Server validates:

- quantity;
- unit price;
- discounts;
- taxable flag/rate;
- included/excluded semantics;
- currency precision;
- rounding policy.

Use one centralized commercial calculation implementation so Deal/Estimate/Invoice rows reconcile.

## Permissions

Manual tax override on a commercial row requires explicit `PRODUCT_ROW.EDIT_TAX` or repository-equivalent permission.

Normal Product selection may apply Catalog tax defaults without granting tax-configuration permission.

## Acceptance criteria

- Row preserves old tax values after master tax changes.
- Unauthorized manual tax override is rejected.
- Server recomputes totals from validated values.
