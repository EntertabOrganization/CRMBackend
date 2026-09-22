/**
 * EntertabCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Partner application contract', () => {
  it('creates PENDING application for a verified/reused global user', async () => {
    contract('partner application creation');
  });

  it('allows only Platform Admin to approve or reject', async () => {
    contract('partner application administration');
  });

  it('approval atomically creates Partner, PartnerMembership, Partner Owner role and discounts', async () => {
    contract('partner approval transaction');
  });

  it('rejection keeps user account and allows future reapplication', async () => {
    contract('partner rejection lifecycle');
  });
});
