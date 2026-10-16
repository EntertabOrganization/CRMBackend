import { verifyContractCase } from '../_harness/adapter';

describe('A/B experiments and nurture journeys (contract)', () => {
  it('Variant allocation 60+30 rejected', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::AC01', "Variant allocation 60+30 rejected");
  });
  it('Same recipient stable A/B arm', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::AC02', "Same recipient stable A/B arm");
  });
  it('Workflow engine outage does not mark journey step successful', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::AC03', "Workflow engine outage does not mark journey step successful");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/09-experiments-and-journeys::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
