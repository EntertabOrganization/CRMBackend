/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Payments service contract', () => {
  it('allocates one successful payment across multiple invoices', async () => {
    await runContractScenario('multi invoice payment allocation');
  });

  it('retains overpayment as non-negative unapplied amount', async () => {
    await runContractScenario('payment unapplied credit');
  });

  it('does not count pending/failed attempts as paid', async () => {
    await runContractScenario('payment settlement status');
  });

  it('rejects allocation above unapplied amount or invoice balance', async () => {
    await runContractScenario('payment allocation invariants');
  });

  it('allocation reversal preserves history and recalculates invoice', async () => {
    await runContractScenario('payment allocation reversal');
  });

});

