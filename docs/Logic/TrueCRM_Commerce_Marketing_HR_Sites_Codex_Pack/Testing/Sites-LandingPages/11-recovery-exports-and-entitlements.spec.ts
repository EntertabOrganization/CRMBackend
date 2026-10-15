import { verifyContractCase } from '../_harness/adapter';

describe('Trash, rollback, portability and subscription behavior (contract)', () => {
  it('Deleting page does not erase immutable audit', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::AC01', "Deleting page does not erase immutable audit");
  });
  it('grace expiry disables new checkout while valid public content remains as entitlement permits', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::AC02', "grace expiry disables new checkout while valid public content remains as entitlement permits");
  });
  it('export excludes secret provider credentials', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::AC03', "export excludes secret provider credentials");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/11-recovery-exports-and-entitlements::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
