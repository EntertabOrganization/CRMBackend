import { verifyContractCase } from '../_harness/adapter';

describe('CRM links, messaging commerce and reconciliation (contract)', () => {
  it('One customer with multiple orders and optional Deals', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::AC01', "One customer with multiple orders and optional Deals");
  });
  it('CRM service down causes visible retry no order loss', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::AC02', "CRM service down causes visible retry no order loss");
  });
  it('conversation agent without permission denied', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::AC03', "conversation agent without permission denied");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/11-crm-sales-links::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
