/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Form versioning contract', () => {
  it('editing published form uses draft and does not change live schema', async () => {
    await runContractScenario('form draft publish isolation');
  });

  it('publish atomically switches public version after complete validation', async () => {
    await runContractScenario('form publish atomicity');
  });

  it('submission records exact version served to visitor', async () => {
    await runContractScenario('submission version binding');
  });

  it('old published versions remain readable for history', async () => {
    await runContractScenario('form historical versions');
  });

  it('publish rejects invalid mapping and conditional references', async () => {
    await runContractScenario('form publish validation');
  });

});

