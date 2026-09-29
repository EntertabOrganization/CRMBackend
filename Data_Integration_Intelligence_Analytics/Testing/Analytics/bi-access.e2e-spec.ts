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

describe('External BI access E2E contract', () => {
  it('never returns production database credentials', async () => {
    contract('BI database isolation');
  });
  it('scopes BI credential to one workspace/service identity', async () => {
    contract('BI tenant scope');
  });
  it('rejects unapproved dataset', async () => {
    contract('BI dataset authorization');
  });
  it('applies rate/query limits', async () => {
    contract('BI limits');
  });
  it('revocation prevents future queries', async () => {
    contract('BI credential revocation');
  });
  it('enforces current data permission policy', async () => {
    contract('BI permission filtering');
  });
});
