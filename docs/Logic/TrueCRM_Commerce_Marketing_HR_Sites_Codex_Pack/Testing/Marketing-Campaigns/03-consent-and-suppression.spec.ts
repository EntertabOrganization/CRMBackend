import { verifyContractCase } from '../_harness/adapter';

describe('Consent, opt-out and suppression policy (contract)', () => {
  it('Unsubscribe after scheduling but before sending excludes recipient', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::AC01', "Unsubscribe after scheduling but before sending excludes recipient");
  });
  it('Complaint blocks next campaign', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::AC02', "Complaint blocks next campaign");
  });
  it('Unknown consent cannot be inferred from import', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::AC03', "Unknown consent cannot be inferred from import");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/03-consent-and-suppression::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
