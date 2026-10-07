/**
 * TrueCRM executable contract test for Calendars Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Calendars Specification contract', () => {
  it('Department membership changes.', async () => {
    contract('Department membership changes.');
  });
  it('Cross-workspace owner/department/project.', async () => {
    contract('Cross-workspace owner/department/project.');
  });
  it('Permission override.', async () => {
    contract('Permission override.');
  });
});
