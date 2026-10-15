import { verifyContractCase } from '../_harness/adapter';

describe('Attendance evaluation and correction requests (contract)', () => {
  it('Historical raw timestamps still queryable after correction', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::AC01', "Historical raw timestamps still queryable after correction");
  });
  it('Two supervisors concurrently approve yields one application', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::AC02', "Two supervisors concurrently approve yields one application");
  });
  it('Locked timesheet period rejects unapproved correction', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::AC03', "Locked timesheet period rejects unapproved correction");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/04-attendance-and-corrections::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
