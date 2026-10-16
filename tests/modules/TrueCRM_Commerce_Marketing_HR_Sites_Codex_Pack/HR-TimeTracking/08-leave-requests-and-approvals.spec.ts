import { verifyContractCase } from '../_harness/adapter';

describe('Leave requests, review chain and availability (contract)', () => {
  it('Insufficient paid balance blocks submit', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::AC01', "Insufficient paid balance blocks submit");
  });
  it('Rejected request restores reserved units', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::AC02', "Rejected request restores reserved units");
  });
  it('calendar has absence without reason', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::AC03', "calendar has absence without reason");
  });
  it('duplicate approve creates one debit', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::AC04', "duplicate approve creates one debit");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('HR-TimeTracking/08-leave-requests-and-approvals::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
