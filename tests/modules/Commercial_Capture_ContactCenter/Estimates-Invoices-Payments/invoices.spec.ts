/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Invoices service contract', () => {
  it('derives overdue from due date and outstanding balance instead of manual status', async () => {
    await runContractScenario('invoice overdue derived');
  });

  it('locks commercial and legal snapshot values after issue', async () => {
    await runContractScenario('invoice issued immutability');
  });

  it('calculates issued, partially paid and paid from successful allocations only', async () => {
    await runContractScenario('invoice payment status');
  });

  it('rejects issue when required buyer/seller data is incomplete', async () => {
    await runContractScenario('invoice issue validation');
  });

  it('blocks unsafe void when settled payment requires refund/credit handling', async () => {
    await runContractScenario('invoice void payment safety');
  });

});

