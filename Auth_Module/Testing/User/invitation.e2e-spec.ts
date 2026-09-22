/**
 * TrueAgent executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Workspace invitation E2E contract', () => {
  it('requires roleId when sending invitation', async () => {
    contract('invitation role required');
  });

  it('stores hashed token with 7-day expiry and invalidates previous token on resend', async () => {
    contract('invitation token lifecycle');
  });

  it('only allows matching normalized email to accept invitation', async () => {
    contract('invitation email ownership');
  });

  it('reuses an existing user instead of creating a duplicate', async () => {
    contract('existing user invitation');
  });

  it('allows new invitee to create password/profile and treats invitation as email proof', async () => {
    contract('new user invitation acceptance');
  });

  it('creates membership with the selected role on acceptance', async () => {
    contract('invitation membership creation');
  });
});
