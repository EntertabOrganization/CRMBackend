/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Form processing contract', () => {
  it('persists immutable submitted data before CRM capture', async () => {
    await runContractScenario('submission first durability');
  });

  it('processing retry resumes completed steps without duplicate entities', async () => {
    await runContractScenario('form processing idempotency');
  });

  it('stores PARTIALLY_FAILED step outcomes for safe retry', async () => {
    await runContractScenario('form partial processing failure');
  });

  it('only clean same-form uploads can bind to final submission', async () => {
    await runContractScenario('form upload security');
  });

  it('consent evidence retains agreement version after agreement changes', async () => {
    await runContractScenario('form consent evidence');
  });

  it('resume token expires and submitted draft cannot be edited as draft', async () => {
    await runContractScenario('form resumable draft lifecycle');
  });

});

