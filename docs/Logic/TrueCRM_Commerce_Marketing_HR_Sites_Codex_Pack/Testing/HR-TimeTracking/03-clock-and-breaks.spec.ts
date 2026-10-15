import { verifyContractCase } from '../_harness/adapter';

describe('Clock-in/out work sessions, breaks and verification (contract)', () => {
  it('Duplicate clock-in returns same session', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::AC01', "Duplicate clock-in returns same session");
  });
  it('Missing clock-out flagged', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::AC02', "Missing clock-out flagged");
  });
  it('GPS disabled means no GPS evidence saved', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::AC03', "GPS disabled means no GPS evidence saved");
  });
  it('same-session overlapping breaks rejected', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::AC04', "same-session overlapping breaks rejected");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/03-clock-and-breaks::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
