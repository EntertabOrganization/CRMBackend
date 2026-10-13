/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('CRM Forms E2E contract', () => {
  it('accepts valid public submission without TrueCRM signup', async () => {
    await runContractScenario('public form E2E');
  });

  it('returns deterministic field errors for invalid submission', async () => {
    await runContractScenario('form validation E2E');
  });

  it('same idempotency key produces one final submission', async () => {
    await runContractScenario('form submit idempotency');
  });

  it('cross-workspace public injection cannot change destination tenant', async () => {
    await runContractScenario('form tenant isolation E2E');
  });

});

