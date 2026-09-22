/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Lost reason contract', () => {
  it('keeps FAILURE stage and lost reason as separate concepts', async () => {
    contract('failure stage versus lost reason');
  });

  it('requires an active reason when entering FAILURE', async () => {
    contract('lost reason required');
  });

  it('prevents selection of a deactivated reason for new transitions', async () => {
    contract('lost reason deactivation');
  });

  it('preserves deactivated reason for historical records', async () => {
    contract('lost reason historical retention');
  });

  it('clears current lost reason when reopened to PROGRESS without erasing history', async () => {
    contract('lost reason reopen behavior');
  });

});
