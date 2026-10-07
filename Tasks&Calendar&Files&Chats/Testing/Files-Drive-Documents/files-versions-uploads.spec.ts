/**
 * TrueCRM executable contract test for Files, Versions & Uploads Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Files, Versions & Uploads Specification contract', () => {
  it('Oversize.', async () => {
    contract('Oversize.');
  });
  it('Quota race.', async () => {
    contract('Quota race.');
  });
  it('Same-name conflict.', async () => {
    contract('Same-name conflict.');
  });
  it('Complete retry.', async () => {
    contract('Complete retry.');
  });
  it('Malware blocked.', async () => {
    contract('Malware blocked.');
  });
  it('Restore immutability.', async () => {
    contract('Restore immutability.');
  });
});
