import { verifyContractCase } from '../_harness/adapter';

describe('Promotions, taxes, shipping quotations (contract)', () => {
  it('Coupon limit 1 with 2 concurrent checkouts succeeds once', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::AC01', "Coupon limit 1 with 2 concurrent checkouts succeeds once");
  });
  it('Multi-tax inclusive/exclusive total reproducible', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::AC02', "Multi-tax inclusive/exclusive total reproducible");
  });
  it('Changing rate never edits historic order', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::AC03', "Changing rate never edits historic order");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/10-promotions-taxes-and-delivery::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
