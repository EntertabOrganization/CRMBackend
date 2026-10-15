import { verifyContractCase } from '../_harness/adapter';

describe('Dynamic/static segments and audience snapshots (contract)', () => {
  it('Frozen campaign count stays unchanged after CRM edit', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::AC01', "Frozen campaign count stays unchanged after CRM edit");
  });
  it('Dynamic preview updates while static unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::AC02', "Dynamic preview updates while static unchanged");
  });
  it('Excluded/suppressed recipient never queued', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::AC03', "Excluded/suppressed recipient never queued");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/01-segments-and-audiences::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
