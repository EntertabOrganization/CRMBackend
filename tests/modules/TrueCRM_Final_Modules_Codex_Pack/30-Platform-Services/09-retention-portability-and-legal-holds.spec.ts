import { verifyContractCase } from '../_harness/adapter';

// Source spec: 30-Platform-Services/09-retention-portability-and-legal-holds.md. These are fail-closed executable contracts, not mocks.
describe('Retention engine, portability and privacy workflows [repository contracts]', () => {
  it('AC01: Legal hold blocks knowledge purge.', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::AC01', 'Legal hold blocks knowledge purge.', 'INTEGRATION');
  });
  it('AC02: Cross-tenant export cannot include unrelated user data.', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::AC02', 'Cross-tenant export cannot include unrelated user data.', 'INTEGRATION');
  });
  it('AC03: Interrupted privacy job resumes without double action.', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::AC03', 'Interrupted privacy job resumes without double action.', 'INTEGRATION');
  });
  it('AC04: Financial audit retained appropriately after user anonymization.', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::AC04', 'Financial audit retained appropriately after user anonymization.', 'INTEGRATION');
  });
  it('AC05: Missing jurisdiction policy blocks production activation.', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::AC05', 'Missing jurisdiction policy blocks production activation.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('30-Platform-Services/09-retention-portability-and-legal-holds::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
