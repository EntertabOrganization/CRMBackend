/**
 * TrueCRM executable contract test for Document Templates & Generated Documents Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Document Templates & Generated Documents Specification contract', () => {
  it('Template injection/invalid variables.', async () => {
    contract('Template injection/invalid variables.');
  });
  it('Job retry.', async () => {
    contract('Job retry.');
  });
  it('Source entity becomes unauthorized.', async () => {
    contract('Source entity becomes unauthorized.');
  });
  it('Regenerate preserving old output.', async () => {
    contract('Regenerate preserving old output.');
  });
});
