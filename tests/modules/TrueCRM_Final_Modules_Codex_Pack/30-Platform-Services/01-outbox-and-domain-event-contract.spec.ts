import { verifyContractCase } from '../_harness/adapter';

// Source spec: 30-Platform-Services/01-outbox-and-domain-event-contract.md. These are fail-closed executable contracts, not mocks.
describe('Transactional outbox and shared event transport [repository contracts]', () => {
  it('AC01: Rollback of domain mutation leaves zero outbox event.', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::AC01', 'Rollback of domain mutation leaves zero outbox event.', 'INTEGRATION');
  });
  it('AC02: Two publishers race and exactly one consumer effect survives.', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::AC02', 'Two publishers race and exactly one consumer effect survives.', 'INTEGRATION');
  });
  it('AC03: Consumer error moves to retry then DLQ; later replay does not duplicate prior effects.', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::AC03', 'Consumer error moves to retry then DLQ; later replay does not duplicate prior effects.', 'INTEGRATION');
  });
  it('AC04: Cross-tenant event reference cannot trigger update in wrong workspace.', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::AC04', 'Cross-tenant event reference cannot trigger update in wrong workspace.', 'INTEGRATION');
  });
  it('AC05: Events preserve aggregate version ordering or safe stale rejection.', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::AC05', 'Events preserve aggregate version ordering or safe stale rejection.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('30-Platform-Services/01-outbox-and-domain-event-contract::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
