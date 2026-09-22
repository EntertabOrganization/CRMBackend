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

describe('Authentication - signup and email verification', () => {
  it('normalizes email and creates one pending user with LOCAL identity', async () => {
    contract('manual signup creates pending user and LOCAL identity');
  });

  it('stores only a hash of the verification token and sets a 24h functional expiry', async () => {
    contract('verification token security');
  });

  it('does not create the first workspace until email verification succeeds', async () => {
    contract('workspace bootstrap waits for verification');
  });

  it('verifies email then atomically creates workspace, Owner/Admin role and membership', async () => {
    contract('verification bootstrap transaction');
  });

  it('logs the user in after verification and returns the active workspace', async () => {
    contract('automatic login after verification');
  });

  it('rolls back bootstrap if an essential workspace bootstrap step fails', async () => {
    contract('no half-created workspace');
  });

  it('rejects duplicate normalized emails', async () => {
    contract('duplicate email protection');
  });
});
