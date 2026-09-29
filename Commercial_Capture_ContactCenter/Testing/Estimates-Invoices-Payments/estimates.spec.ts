/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Estimates service contract', () => {
  it('maps configurable stages to stable semantic states', async () => {
    await runContractScenario('estimate semantic stage mapping');
  });

  it('recalculates line totals using precise server-side arithmetic', async () => {
    await runContractScenario('estimate totals');
  });

  it('creates a new revision instead of mutating a sent revision', async () => {
    await runContractScenario('estimate revision immutability');
  });

  it('rejects cross-workspace customer, seller and product references', async () => {
    await runContractScenario('estimate tenant isolation');
  });

  it('accepts only an eligible sent revision and records exact revision', async () => {
    await runContractScenario('estimate acceptance revision');
  });

  it('enforces record scopes on commercial mutations', async () => {
    await runContractScenario('commercial mutation record scope');
  });

});

