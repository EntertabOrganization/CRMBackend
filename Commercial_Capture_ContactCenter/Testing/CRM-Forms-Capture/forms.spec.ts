/**
 * TrueCRM executable contract test.
 *
 * Wire this file to the real repository implementation.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/actions/assertions.
 */

import { runContractScenario } from '../harness';

describe('CRM Forms core contract', () => {
  it('supports SUBMISSION_ONLY and CRM_CAPTURE modes', async () => {
    await runContractScenario('form modes');
  });

  it('supports PUBLIC AUTHENTICATED and RESTRICTED_TOKEN access', async () => {
    await runContractScenario('form access modes');
  });

  it('does not trust public workspace or privileged target IDs', async () => {
    await runContractScenario('form public tenant injection');
  });

  it('unpublishing blocks new submissions without deleting old ones', async () => {
    await runContractScenario('form unpublish history');
  });

  it('enforces form/submission read permissions and scopes', async () => {
    await runContractScenario('form permissions');
  });

});

