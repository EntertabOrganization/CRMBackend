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

describe('CRM Workspace isolation E2E contract', () => {
  it('returns the same not-found shape for nonexistent and other-workspace Lead IDs', async () => {
    contract('lead cross-tenant probing protection');
  });

  it('returns the same not-found shape for nonexistent and other-workspace Deal IDs', async () => {
    contract('deal cross-tenant probing protection');
  });

  it('never links a Contact Company or pipeline from another Workspace', async () => {
    contract('crm cross-workspace foreign key protection');
  });

  it('applies authorization scope before cursor pagination', async () => {
    contract('authorized cursor pagination');
  });

});

export {};
