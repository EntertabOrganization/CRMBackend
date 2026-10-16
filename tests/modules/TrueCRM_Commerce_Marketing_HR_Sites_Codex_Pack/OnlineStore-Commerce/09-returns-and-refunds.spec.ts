import { verifyContractCase } from '../_harness/adapter';

describe('Returns, inspection, refunds and restocking (contract)', () => {
  it('Partial return of 1/3 quantities does not over-refund', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::AC01', "Partial return of 1/3 quantities does not over-refund");
  });
  it('Damaged item disposition NO_RESTOCK keeps stock unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::AC02', "Damaged item disposition NO_RESTOCK keeps stock unchanged");
  });
  it('Replayed refund callback has one effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::AC03', "Replayed refund callback has one effect");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/09-returns-and-refunds::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
