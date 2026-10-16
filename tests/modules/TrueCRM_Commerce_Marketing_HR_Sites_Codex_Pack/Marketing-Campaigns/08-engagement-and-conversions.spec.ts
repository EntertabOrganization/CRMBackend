import { verifyContractCase } from '../_harness/adapter';

describe('Engagement signals and reporting (contract)', () => {
  it('Duplicate click callback counted once as unique', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::AC01', "Duplicate click callback counted once as unique");
  });
  it('Analytics counts reconcile attempted+skipped', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::AC02', "Analytics counts reconcile attempted+skipped");
  });
  it('Customer optout does not destroy historical anonymized metrics', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::AC03', "Customer optout does not destroy historical anonymized metrics");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/08-engagement-and-conversions::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
