/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Contact Center E2E contract', () => {
  it('inbound event resolves customer creates/routes conversation and persists message', async () => {
    await runContractScenario('contact center inbound E2E');
  });

  it('returning confirmed identity matches same CRM customer', async () => {
    await runContractScenario('customer identity match E2E');
  });

  it('ambiguous CRM identity remains controlled rather than wrong-linked', async () => {
    await runContractScenario('ambiguous identity E2E');
  });

  it('human agent can send suggested AI reply but AI cannot auto-send', async () => {
    await runContractScenario('AI human send control');
  });

  it('cross-workspace conversation access and CRM binding are rejected', async () => {
    await runContractScenario('contact center tenant isolation');
  });

});

