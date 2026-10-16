import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/01-public-applications-and-approval.md. These are fail-closed executable contracts, not mocks.
describe('Public Partner application, verification and atomic approval [repository contracts]', () => {
  it('AC01: Concurrent admins approving same application produce exactly one Partner.', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::AC01', 'Concurrent admins approving same application produce exactly one Partner.', 'INTEGRATION');
  });
  it('AC02: Applicant with existing User reuses identity.', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::AC02', 'Applicant with existing User reuses identity.', 'INTEGRATION');
  });
  it('AC03: Non-Platform Admin approve returns 403 and does not create Partner.', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::AC03', 'Non-Platform Admin approve returns 403 and does not create Partner.', 'INTEGRATION');
  });
  it('AC04: Reject then reapply preserves old application.', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::AC04', 'Reject then reapply preserves old application.', 'INTEGRATION');
  });
  it('AC05: Duplicate probable org raises review instead of merging unrelated legal entities.', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::AC05', 'Duplicate probable org raises review instead of merging unrelated legal entities.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/01-public-applications-and-approval::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
