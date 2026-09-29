/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Recurring invoices contract', () => {
  it('creates exactly one invoice per occurrence key despite retries', async () => {
    await runContractScenario('recurring occurrence idempotency');
  });

  it('supports draft-only and auto-issue-send modes', async () => {
    await runContractScenario('recurring issue modes');
  });

  it('rule edits affect future occurrences but not generated invoices', async () => {
    await runContractScenario('recurring history stability');
  });

  it('calculates occurrences using configured IANA timezone', async () => {
    await runContractScenario('recurring timezone');
  });

  it('failed occurrence is visible and safely retryable', async () => {
    await runContractScenario('recurring failure retry');
  });

});

