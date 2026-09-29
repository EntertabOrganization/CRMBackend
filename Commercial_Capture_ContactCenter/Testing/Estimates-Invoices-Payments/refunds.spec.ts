/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Refunds contract', () => {
  it('supports several partial refunds up to available refundable amount', async () => {
    await runContractScenario('partial refunds');
  });

  it('prevents concurrent refunds from exceeding available amount', async () => {
    await runContractScenario('refund concurrency');
  });

  it('keeps original successful payment history after refund', async () => {
    await runContractScenario('payment refund history');
  });

  it('requires allocation adjustment before refunding allocated money', async () => {
    await runContractScenario('refund allocation safety');
  });

  it('deduplicates refund request and provider callback', async () => {
    await runContractScenario('refund idempotency');
  });

});

