import { verifyContractCase } from '../_harness/adapter';

describe('Stores and storefront configuration (contract)', () => {
  it('Two stores in one workspace with different currencies', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::AC01', "Two stores in one workspace with different currencies");
  });
  it('URL route collision fails 409', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::AC02', "URL route collision fails 409");
  });
  it('Cross-tenant store ID denied', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::AC03', "Cross-tenant store ID denied");
  });
  it('Suspended store denies new checkout while existing obligations remain accessible', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::AC04', "Suspended store denies new checkout while existing obligations remain accessible");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/01-store-administration::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
