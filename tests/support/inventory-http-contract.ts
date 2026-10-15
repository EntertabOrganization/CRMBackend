import { packHttpContract, type PublicScenario, type ScenarioBuilder } from './workflow-http-contract';
import type { InventoryFixture } from './inventory-contract';

/** Real Inventory router HTTP contracts (Nest adapter + Next dispatch) against one owned migrated database. */
export function inventoryHttpContract(database: string, scenarios: Record<string, ScenarioBuilder<InventoryFixture> | PublicScenario<InventoryFixture>>) {
  return packHttpContract<InventoryFixture>(database, async () => (await import('../../src/server/inventory/routes')).inventoryRouter,
    async () => (await import('./inventory-contract')).inventoryFixture, scenarios);
}
export type { HttpScenario } from './workflow-http-contract';
