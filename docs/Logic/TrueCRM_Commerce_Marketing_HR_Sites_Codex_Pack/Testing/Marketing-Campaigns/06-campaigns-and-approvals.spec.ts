import { verifyContractCase } from '../_harness/adapter';

describe('Campaign lifecycle, approvals and scheduling (contract)', () => {
  it('Changing approved content requires reapproval', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::AC01', "Changing approved content requires reapproval");
  });
  it('DST scheduled campaign executes one run only', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::AC02', "DST scheduled campaign executes one run only");
  });
  it('Pause mid-send never resends accepted messages', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::AC03', "Pause mid-send never resends accepted messages");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/06-campaigns-and-approvals::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
