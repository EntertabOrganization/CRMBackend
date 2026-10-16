import { verifyContractCase } from '../_harness/adapter';

describe('Employee daily/weekly/monthly work reports (contract)', () => {
  it('Work report submission does not increase attendance hours', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::AC01', "Work report submission does not increase attendance hours");
  });
  it('Reporter cannot read unrelated team reports', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::AC02', "Reporter cannot read unrelated team reports");
  });
  it('Reviewed version preserved', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::AC03', "Reviewed version preserved");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/09-work-reports::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
