/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Bank Data contract', () => {
  it('requires bank_data.view separately from requisite.read', async () => {
    await runContractScenario('bank view permission');
  });

  it('supports multiple bank accounts and deterministic default', async () => {
    await runContractScenario('bank multiple/default');
  });

  it('audits changes without full sensitive account values in audit/logs', async () => {
    await runContractScenario('bank audit masking');
  });

  it('rejects bank account from another ownership chain/workspace', async () => {
    await runContractScenario('bank ownership chain');
  });

  it('archived bank account cannot be selected for new documents', async () => {
    await runContractScenario('bank archive selection');
  });

});

