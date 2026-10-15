import { verifyContractCase } from '../_harness/adapter';

describe('Digital downloads and non-shippable services (contract)', () => {
  it('Guest purchaser receives bounded secure digital download', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::AC01', "Guest purchaser receives bounded secure digital download");
  });
  it('mixed cart results in shipping only physical lines', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::AC02', "mixed cart results in shipping only physical lines");
  });
  it('refunded digital order access follows configured policy', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::AC03', "refunded digital order access follows configured policy");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/13-digital-goods-and-service-fulfillment::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
