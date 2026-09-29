/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Contact Center routing contract', () => {
  it('router excludes inactive off-hours absent and over-capacity agents', async () => {
    await runContractScenario('routing eligibility');
  });

  it('round-robin is safe under concurrent conversations', async () => {
    await runContractScenario('routing round robin concurrency');
  });

  it('least-loaded uses deterministic tie breaking', async () => {
    await runContractScenario('routing least loaded');
  });

  it('broadcast claim has exactly one successful claimant', async () => {
    await runContractScenario('routing broadcast claim');
  });

  it('customer-owner falls back when CRM owner is ineligible', async () => {
    await runContractScenario('routing customer owner fallback');
  });

});

