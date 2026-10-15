import { verifyContractCase } from '../_harness/adapter';

describe('Website A/B tests and stable visitor allocation (contract)', () => {
  it('Repeat visit sees same variant', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::AC01', "Repeat visit sees same variant");
  });
  it('allocations 70+40 rejected', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::AC02', "allocations 70+40 rejected");
  });
  it('consent denied does not create persistent tracking cookie', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::AC03', "consent denied does not create persistent tracking cookie");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/09-ab-experiments::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
