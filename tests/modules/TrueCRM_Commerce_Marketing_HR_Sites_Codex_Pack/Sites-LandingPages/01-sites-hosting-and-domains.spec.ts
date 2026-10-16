import { verifyContractCase } from '../_harness/adapter';

describe('Site configuration, domains, SSL and managed hosting (contract)', () => {
  it('Custom domain takeover attempt fails', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::AC01', "Custom domain takeover attempt fails");
  });
  it('Unverified host does not serve content', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::AC02', "Unverified host does not serve content");
  });
  it('Two sites cannot register colliding host/routes', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::AC03', "Two sites cannot register colliding host/routes");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/01-sites-hosting-and-domains::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
