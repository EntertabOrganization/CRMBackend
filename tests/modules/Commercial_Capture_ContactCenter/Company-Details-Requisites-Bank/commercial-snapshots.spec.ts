/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Commercial snapshots contract', () => {
  it('resolves workspace/context seller default deterministically', async () => {
    await runContractScenario('seller default resolution');
  });

  it('rejects seller requisite or bank account from wrong ownership chain', async () => {
    await runContractScenario('seller ownership validation');
  });

  it('copies legal address and bank values instead of live IDs only', async () => {
    await runContractScenario('commercial snapshot values');
  });

  it('master edits never mutate sent estimate or issued invoice snapshot', async () => {
    await runContractScenario('snapshot immutability');
  });

  it('regenerating old issued document uses stored snapshot values', async () => {
    await runContractScenario('snapshot document regeneration');
  });

});

