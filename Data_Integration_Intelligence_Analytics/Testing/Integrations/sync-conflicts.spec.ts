export {};

/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Synchronization conflict contract', () => {
  it('supports TrueCRM-wins, external-wins, last-modified, field-ownership and manual policies', async () => {
    contract('conflict policies');
  });
  it('keeps unresolved manual conflict visible instead of silently overwriting', async () => {
    contract('manual conflict visibility');
  });
  it('rechecks versions before applying manual resolution', async () => {
    contract('conflict stale-state check');
  });
  it('audits conflict resolution', async () => {
    contract('conflict resolution audit');
  });
});
