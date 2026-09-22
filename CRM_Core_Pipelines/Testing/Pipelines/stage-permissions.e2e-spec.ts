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

describe('Stage permissions E2E contract', () => {
  it('enforces source-stage leave permission', async () => {
    contract('stage leave permission');
  });

  it('enforces target-stage enter permission', async () => {
    contract('stage enter permission');
  });

  it('does not let transition override bypass stage access', async () => {
    contract('override does not bypass stage permission');
  });

  it('does not let stage rules bypass base entity scope permissions', async () => {
    contract('stage permission composition');
  });

});
