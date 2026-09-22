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

describe('Stage contract', () => {
  it('keeps stable stage ID across rename and reorder', async () => {
    contract('stage stable identity');
  });

  it('enforces exactly one default PROGRESS stage per active pipeline', async () => {
    contract('default stage invariant');
  });

  it('enforces exactly one SUCCESS stage per active pipeline', async () => {
    contract('single success stage');
  });

  it('requires at least one PROGRESS and one FAILURE stage', async () => {
    contract('minimum stage semantics');
  });

  it('keeps deactivated stages resolvable from historical rows', async () => {
    contract('historical stage resolution');
  });

});
