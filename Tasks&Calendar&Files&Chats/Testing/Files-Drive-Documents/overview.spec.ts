/**
 * TrueCRM executable contract test for Files, Drive & Documents — Domain Overview.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Files, Drive & Documents — Domain Overview contract', () => {
  it('Version immutability.', async () => {
    contract('Version immutability.');
  });
  it('ACL inheritance and business-record intersection.', async () => {
    contract('ACL inheritance and business-record intersection.');
  });
  it('Public token expiry/password/revocation.', async () => {
    contract('Public token expiry/password/revocation.');
  });
  it('Quarantine blocks access.', async () => {
    contract('Quarantine blocks access.');
  });
  it('Quota and upload-size failures.', async () => {
    contract('Quota and upload-size failures.');
  });
});
