import { verifyContractCase } from '../_harness/adapter';

describe('CRM Forms, live commerce blocks and contact widgets (contract)', () => {
  it('Broken form shows unavailable and does not fabricate lead', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::AC01', "Broken form shows unavailable and does not fabricate lead");
  });
  it('linked product from other workspace rejected', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::AC02', "linked product from other workspace rejected");
  });
  it('checkout block uses actual Commerce confirmation', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::AC03', "checkout block uses actual Commerce confirmation");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/07-form-commerce-and-widget-blocks::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
