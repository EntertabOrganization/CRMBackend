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

describe('Audit/retention/security contract', () => {
  it('critical mutation produces sanitized immutable audit evidence', async () => {
    contract('central audit');
  });
  it('audit contains no reusable credential secret', async () => {
    contract('audit secret redaction');
  });
  it('retention job does not purge legal-held evidence', async () => {
    contract('legal hold');
  });
  it('archived model/rule remains resolvable by historical result', async () => {
    contract('historical configuration retention');
  });
  it('export artifact expires independently from retained job metadata', async () => {
    contract('artifact vs metadata retention');
  });
  it('detailed provider payload retention follows policy', async () => {
    contract('integration payload retention');
  });
});
