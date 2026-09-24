# Test Coverage Matrix

| Capability | Unit/Domain | API/E2E | Security/Tenant | Frontend |
|---|---:|---:|---:|---:|
| Rule Draft/revision/publish | ✓ | ✓ | ✓ | ✓ |
| Trigger/target registry | ✓ | ✓ | ✓ | ✓ |
| Typed condition engine | ✓ | indirect | input safety | ✓ |
| Multiple Rule ordering | ✓ | ✓ | - | - |
| Delayed/revision pinning/stale check | ✓ | ✓ | - | logs |
| Action failure/retry/idempotency | ✓ | ✓ | ✓ | logs |
| Loop/depth guard | ✓ | ✓ | ✓ | logs |
| Dry run/manual execution | ✓ | ✓ | ✓ | ✓ |
| Custom Trigger/Action extension | ✓ | ✓ | ✓ | metadata |
| Catalog/default | ✓ | ✓ | ✓ | ✓ |
| Categories/tree/membership | ✓ | ✓ | ✓ | ✓ |
| Product types/SKU | ✓ | ✓ | ✓ | ✓ |
| Variant inheritance/matrix | ✓ | ✓ | scope | ✓ |
| Product properties | target shared field tests + Product integration | ✓ | ✓ | ✓ |
| Units/ratios | ✓ | ✓ | ✓ | ✓ |
| Price Types/prices | ✓ | ✓ | ✓ | ✓ |
| Tax defaults/snapshots | ✓ | ✓ | override permission | ✓ |
| Product Rows/manual rows | ✓ | ✓ | ✓ | ✓ |
| Archive/dependency deletion | ✓ | ✓ | ✓ | ✓ |
| Cross-Workspace isolation | - | ✓ | **mandatory** | - |
| Outbox/events | ✓ | ✓ | dedupe | realtime where applicable |
