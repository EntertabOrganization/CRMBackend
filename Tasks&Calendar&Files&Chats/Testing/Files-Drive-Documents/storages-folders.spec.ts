/**
 * TrueCRM executable contract test for Storages & Folders Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Storages & Folders Specification contract', () => {
  it('Hierarchy cycle.', async () => {
    contract('Hierarchy cycle.');
  });
  it('Trash/restore with missing original parent.', async () => {
    contract('Trash/restore with missing original parent.');
  });
  it('Project storage provisioning retry.', async () => {
    contract('Project storage provisioning retry.');
  });
});
