import { verifyContractCase } from '../_harness/adapter';

describe('Orders, protected statuses and amendments (contract)', () => {
  it('Historical line snapshots remain stable after catalog edit', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::AC01', "Historical line snapshots remain stable after catalog edit");
  });
  it('Cannot rewrite shipped line', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::AC02', "Cannot rewrite shipped line");
  });
  it('Repeated status commands do not duplicate events', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::AC03', "Repeated status commands do not duplicate events");
  });
  it('Refund is not same as cancel', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::AC04', "Refund is not same as cancel");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/05-orders-and-amendments::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
