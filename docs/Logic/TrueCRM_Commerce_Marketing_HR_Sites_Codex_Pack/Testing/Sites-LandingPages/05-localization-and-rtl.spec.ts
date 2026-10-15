import { verifyContractCase } from '../_harness/adapter';

describe('Language-specific routes and content revisions (contract)', () => {
  it('Arabic RTL navigation renders correctly', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::AC01', "Arabic RTL navigation renders correctly");
  });
  it('missing FR translation fallback language metadata correct', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::AC02', "missing FR translation fallback language metadata correct");
  });
  it('unreviewed AI draft not on public', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::AC03', "unreviewed AI draft not on public");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/05-localization-and-rtl::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
