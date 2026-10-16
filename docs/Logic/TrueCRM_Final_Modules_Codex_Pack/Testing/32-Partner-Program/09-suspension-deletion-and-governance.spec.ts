import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/09-suspension-deletion-and-governance.md. These are fail-closed executable contracts, not mocks.
describe('Partner suspension, deletion, restore and retention [repository contracts]', () => {
  it('AC01: Suspension blocks delegated access immediately.', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::AC01', 'Suspension blocks delegated access immediately.', 'INTEGRATION');
  });
  it('AC02: Customer can still view own paid subscription.', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::AC02', 'Customer can still view own paid subscription.', 'INTEGRATION');
  });
  it('AC03: Soft delete retains invoice relation snapshot.', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::AC03', 'Soft delete retains invoice relation snapshot.', 'INTEGRATION');
  });
  it('AC04: Reactivation does not regrant revoked customer access.', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::AC04', 'Reactivation does not regrant revoked customer access.', 'INTEGRATION');
  });
  it('AC05: Legal hold blocks hard purge.', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::AC05', 'Legal hold blocks hard purge.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/09-suspension-deletion-and-governance::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
