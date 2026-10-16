import { verifyContractCase } from '../_harness/adapter';

describe('Cookie preferences, analytics script sandbox and visitor privacy (contract)', () => {
  it('Analytics tag not loaded before opt-in', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::AC01', "Analytics tag not loaded before opt-in");
  });
  it('malicious script rejected', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::AC02', "malicious script rejected");
  });
  it('revoked script omitted from next published release and isolated from API credentials', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::AC03', "revoked script omitted from next published release and isolated from API credentials");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/08-cookies-scripts-and-security::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
