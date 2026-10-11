/**
 * TrueCRM executable contract test for Files, Drive & Documents — Domain Overview.
 * MUST be wired to the real repository implementation.
 */

import { fileOverviewScenarios } from '../support/file-scenarios';

describe('Files, Drive & Documents — Domain Overview contract', () => {
  it('Version immutability.', async () => {
    await fileOverviewScenarios['Version immutability.']();
  });
  it('ACL inheritance and business-record intersection.', async () => {
    await fileOverviewScenarios['ACL inheritance and business-record intersection.']();
  });
  it('Public token expiry/password/revocation.', async () => {
    await fileOverviewScenarios['Public token expiry/password/revocation.']();
  });
  it('Quarantine blocks access.', async () => {
    await fileOverviewScenarios['Quarantine blocks access.']();
  });
  it('Quota and upload-size failures.', async () => {
    await fileOverviewScenarios['Quota and upload-size failures.']();
  });
});
