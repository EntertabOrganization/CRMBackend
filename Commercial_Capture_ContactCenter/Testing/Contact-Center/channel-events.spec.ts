/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('Channel connectors contract', () => {
  it('invalid provider signature/token cannot create inbound message', async () => {
    await runContractScenario('channel verification');
  });

  it('same external event/message ID produces one domain message', async () => {
    await runContractScenario('channel inbound dedupe');
  });

  it('outbound send persists local message before provider delivery and retries safely', async () => {
    await runContractScenario('channel outbound durable send');
  });

  it('normalizes delivery states without inventing unsupported READ', async () => {
    await runContractScenario('channel delivery normalization');
  });

  it('provider credentials are not returned or logged', async () => {
    await runContractScenario('channel secret hygiene');
  });

});

