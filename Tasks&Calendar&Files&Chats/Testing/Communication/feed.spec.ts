/**
 * TrueCRM executable contract test for Feed Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Feed Specification contract', () => {
  it('Dynamic vs snapshot audience.', async () => {
    contract('Dynamic vs snapshot audience.');
  });
  it('Mention unauthorized user.', async () => {
    contract('Mention unauthorized user.');
  });
  it('Anonymous poll privacy.', async () => {
    contract('Anonymous poll privacy.');
  });
  it('Workspace-wide permission.', async () => {
    contract('Workspace-wide permission.');
  });
});
