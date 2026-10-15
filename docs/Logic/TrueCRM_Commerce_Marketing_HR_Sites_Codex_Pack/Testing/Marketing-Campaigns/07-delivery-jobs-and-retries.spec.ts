import { verifyContractCase } from '../_harness/adapter';

describe('Send orchestration, throttling and retry ledger (contract)', () => {
  it('Concurrent workers process a delivery once', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::AC01', "Concurrent workers process a delivery once");
  });
  it('Recipient opts out while job queued -> SUPPRESSED', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::AC02', "Recipient opts out while job queued -> SUPPRESSED");
  });
  it('provider timeout followed by accepted event never creates second send', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::AC03', "provider timeout followed by accepted event never creates second send");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/07-delivery-jobs-and-retries::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
