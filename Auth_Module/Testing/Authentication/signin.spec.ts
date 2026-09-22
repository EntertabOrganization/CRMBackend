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

describe('Authentication - signin and refresh', () => {
  it('signs in an ACTIVE verified non-deleted user with correct password', async () => {
    contract('local signin success');
  });

  it('rejects unverified, suspended and soft-deleted users', async () => {
    contract('signin state checks');
  });

  it('uses lastActiveWorkspaceId only when active membership still exists', async () => {
    contract('last workspace validation');
  });

  it('falls back to the first active workspace membership when stored workspace is invalid', async () => {
    contract('workspace fallback');
  });

  it('rotates refresh tokens and invalidates the previous token', async () => {
    contract('refresh rotation');
  });

  it('rejects expired or revoked refresh sessions', async () => {
    contract('refresh expiry and revocation');
  });

  it('logout revokes current session and logout-all revokes all sessions', async () => {
    contract('logout semantics');
  });
});
