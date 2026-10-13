/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Estimates E2E contract', () => {
  it('supports create -> send -> revise -> resend while preserving first sent version', async () => {
    await runContractScenario('estimate revision E2E');
  });

  it('supports accepted estimate -> multiple invoices without rewriting estimate', async () => {
    await runContractScenario('estimate multi invoice conversion');
  });

  it('replaying same conversion idempotency key does not create another invoice', async () => {
    await runContractScenario('estimate conversion idempotency');
  });

  it('writes required audit and outbox events for send/accept/convert', async () => {
    await runContractScenario('estimate audit events');
  });

});

