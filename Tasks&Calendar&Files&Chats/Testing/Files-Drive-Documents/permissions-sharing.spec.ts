/**
 * TrueCRM executable contract test for File Permissions & Sharing Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('File Permissions & Sharing Specification contract', () => {
  it('Inheritance override.', async () => {
    contract('Inheritance override.');
  });
  it('Project role vs file override.', async () => {
    contract('Project role vs file override.');
  });
  it('Expired/password/limit public link.', async () => {
    contract('Expired/password/limit public link.');
  });
  it('Folder move out of public tree.', async () => {
    contract('Folder move out of public tree.');
  });
});
