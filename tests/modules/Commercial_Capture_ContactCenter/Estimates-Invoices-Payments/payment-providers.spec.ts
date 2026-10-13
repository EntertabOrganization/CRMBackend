/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Payment provider adapter contract', () => {
  it('normalizes Stripe XPay and fake provider events through one domain contract', async () => {
    await runContractScenario('provider adapter abstraction');
  });

  it('rejects invalid signature or authoritative lookup mismatch', async () => {
    await runContractScenario('provider verification');
  });

  it('rejects amount currency or merchant/community mismatch', async () => {
    await runContractScenario('provider expected value checks');
  });

  it('does not settle from browser redirect alone', async () => {
    await runContractScenario('redirect not settlement');
  });

  it('acknowledges duplicate provider event without duplicate side effect', async () => {
    await runContractScenario('provider event idempotency');
  });

});

