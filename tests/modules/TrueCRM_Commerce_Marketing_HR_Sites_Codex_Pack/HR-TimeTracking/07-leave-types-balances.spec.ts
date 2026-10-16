import { verifyContractCase } from '../_harness/adapter';

describe('Leave entitlements, accruals, balances and holidays (contract)', () => {
  it('Two leave requests cannot overdraft 1 remaining day', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::AC01', "Two leave requests cannot overdraft 1 remaining day");
  });
  it('Holiday skipped from deduction per policy', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::AC02', "Holiday skipped from deduction per policy");
  });
  it('carry-over preserves version trace', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::AC03', "carry-over preserves version trace");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/07-leave-types-balances::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
