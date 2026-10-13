/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Payments E2E contract', () => {
  it('manual payment plus allocations updates affected invoices atomically', async () => {
    await runContractScenario('manual payment allocation E2E');
  });

  it('concurrent allocations cannot spend same unapplied amount twice', async () => {
    await runContractScenario('payment allocation concurrency');
  });

  it('duplicate settlement callback results in one financial effect', async () => {
    await runContractScenario('payment provider dedupe E2E');
  });

  it('cross-workspace payment and invoice allocation is rejected', async () => {
    await runContractScenario('payment tenant isolation');
  });

});

