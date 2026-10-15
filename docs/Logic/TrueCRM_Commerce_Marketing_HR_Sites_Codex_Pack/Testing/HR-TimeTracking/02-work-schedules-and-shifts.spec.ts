import { verifyContractCase } from '../_harness/adapter';

describe('Schedule versions, assignments, shifts and work locations (contract)', () => {
  it('Overnight shift counts correctly', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::AC01', "Overnight shift counts correctly");
  });
  it('DST timezone case', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::AC02', "DST timezone case");
  });
  it('overlapping assignment rejected', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::AC03', "overlapping assignment rejected");
  });
  it('historical approved timesheet unaffected by schedule edit', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::AC04', "historical approved timesheet unaffected by schedule edit");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/02-work-schedules-and-shifts::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
