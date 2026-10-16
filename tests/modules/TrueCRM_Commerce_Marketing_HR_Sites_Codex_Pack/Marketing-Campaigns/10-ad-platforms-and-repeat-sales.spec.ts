import { verifyContractCase } from '../_harness/adapter';

describe('Advertising audiences and repeat-sales campaigns (contract)', () => {
  it('Consent withdrawn -> subject removed when adapter supports', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::AC01', "Consent withdrawn -> subject removed when adapter supports");
  });
  it('Import same ad metrics period idempotent', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::AC02', "Import same ad metrics period idempotent");
  });
  it('Ads API quota error yields partial report and retry', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::AC03', "Ads API quota error yields partial report and retry");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/10-ad-platforms-and-repeat-sales::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
