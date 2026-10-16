import { verifyContractCase } from '../_harness/adapter';

describe('Sender identity and provider connections (contract)', () => {
  it('Unverified sender cannot schedule', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::AC01', "Unverified sender cannot schedule");
  });
  it('Revoked credentials pause unattempted deliveries', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::AC02', "Revoked credentials pause unattempted deliveries");
  });
  it('Provider quota response delays rather than duplicates sends', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::AC03', "Provider quota response delays rather than duplicates sends");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/04-sender-and-provider-config::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
