import { verifyContractCase } from '../_harness/adapter';

describe('Timesheet compilation, submissions, approvals and locking (contract)', () => {
  it('Submitting two times same version creates one review', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::AC01', "Submitting two times same version creates one review");
  });
  it('Locked correction rejected until reopen', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::AC02', "Locked correction rejected until reopen");
  });
  it('8h task time is not added to 8h attendance', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::AC03', "8h task time is not added to 8h attendance");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/05-timesheets::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
