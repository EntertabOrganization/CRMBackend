/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Requisites service contract', () => {
  it('allows multiple requisites for Contact or Company with deterministic defaults', async () => {
    await runContractScenario('multiple requisites default');
  });

  it('validates country plus entity-type preset required fields', async () => {
    await runContractScenario('requisite preset validation');
  });

  it('supports multiple typed addresses with default rules', async () => {
    await runContractScenario('requisite addresses');
  });

  it('archives referenced requisites instead of destructive deletion', async () => {
    await runContractScenario('requisite archive referenced');
  });

  it('rejects cross-workspace owner preset and address references', async () => {
    await runContractScenario('requisite tenant isolation');
  });

  it('enforces record scopes for Requisite and Bank Data access', async () => {
    await runContractScenario('requisite and bank record scopes');
  });

});

