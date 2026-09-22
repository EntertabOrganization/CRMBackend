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

describe('CRM lifecycle contract', () => {
  it('distinguishes active archived and soft-deleted behavior', async () => {
    contract('crm archive delete separation');
  });

  it('restores archived and soft-deleted records according to permissions', async () => {
    contract('crm lifecycle restore');
  });

  it('blocks soft delete while protected references exist', async () => {
    contract('crm active reference protection');
  });

  it('never removes centralized audit evidence on hard delete', async () => {
    contract('crm hard delete audit retention');
  });

  it('requires reassignment before removing a responsible Workspace member', async () => {
    contract('responsible user offboarding');
  });

});
