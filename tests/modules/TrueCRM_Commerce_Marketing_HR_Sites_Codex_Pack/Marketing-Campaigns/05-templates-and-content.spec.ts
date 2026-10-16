import { verifyContractCase } from '../_harness/adapter';

describe('Campaign content, personalization and versions (contract)', () => {
  it('Updated template version does not affect queued frozen campaign', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::AC01', "Updated template version does not affect queued frozen campaign");
  });
  it('Unknown personalization token prevents launch', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::AC02', "Unknown personalization token prevents launch");
  });
  it('Test email not counted as live campaign delivery', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::AC03', "Test email not counted as live campaign delivery");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/05-templates-and-content::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
