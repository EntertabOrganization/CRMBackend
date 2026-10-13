# Shared Warehouse Address bindings

The default Warehouse service validates `location` through the owning Requisite Address authority. It re-resolves active Workspace membership and explicit `requisite.read` scope, then checks the active Address, active Requisite and existing same-Workspace CRM owner. The shared Address and Requisite records are held stable until the Warehouse binding commits. Inventory stores their identity and does not duplicate or mutate Address data.

Migration `202610140001_inventory_shared_addresses` enforces the same tenant/ownership chain for direct Warehouse database writes, including JSON/record Workspace identity and missing owner metadata. An existing historical binding can remain after its owning record is archived; new or changed bindings must resolve an available chain. Runtime failures and database rejection leave no partial Warehouse/audit/outbox effects.

`tests/inventory-address.spec.ts` verifies real owning records, permissions, ownership scope, lifecycle, foreign references, direct database guards and immutable source records. Migration verification used owned disposable databases only. Broader Inventory work remains tracked in the root implementation record.
