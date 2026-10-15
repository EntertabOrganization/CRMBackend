import { verifyContractCase } from '../_harness/adapter';

describe('Page hierarchy, routes, navigation and CMS entries (contract)', () => {
  it('Duplicate locale slug fails', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::AC01', "Duplicate locale slug fails");
  });
  it('redirect loop rejected', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::AC02', "redirect loop rejected");
  });
  it('new draft navigation not visible until release activation', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::AC03', "new draft navigation not visible until release activation");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/02-pages-navigation-and-cms::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
