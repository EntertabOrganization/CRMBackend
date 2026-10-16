import { verifyContractCase } from '../_harness/adapter';

describe('Storefront customer accounts and self-service (contract)', () => {
  it('Guest can view just their own order through valid token', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::AC01', "Guest can view just their own order through valid token");
  });
  it('Expired order-access token denied', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::AC02', "Expired order-access token denied");
  });
  it('Workspace employee credential cannot act as storefront customer automatically', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::AC03', "Workspace employee credential cannot act as storefront customer automatically");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/03-customer-identities-and-portal::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
