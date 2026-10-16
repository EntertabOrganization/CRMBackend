import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/01-spaces-and-hierarchy.md. These are fail-closed executable contracts, not mocks.
describe('Knowledge spaces, hierarchy and organization [repository contracts]', () => {
  it('AC01: An authorized user creates a space and nested hierarchy; GET tree preserves sibling ordering.', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::AC01', 'An authorized user creates a space and nested hierarchy; GET tree preserves sibling ordering.', 'INTEGRATION');
  });
  it('AC02: Attempt to move parent under its descendant returns 409 and leaves tree unchanged.', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::AC02', 'Attempt to move parent under its descendant returns 409 and leaves tree unchanged.', 'INTEGRATION');
  });
  it('AC03: Cross-workspace parent/space IDs are rejected without information leakage.', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::AC03', 'Cross-workspace parent/space IDs are rejected without information leakage.', 'INTEGRATION');
  });
  it('AC04: Moving shared article into private space revokes old discovery access and invalidates AI/search ACL caches.', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::AC04', 'Moving shared article into private space revokes old discovery access and invalidates AI/search ACL caches.', 'INTEGRATION');
  });
  it('AC05: Concurrent moves use expectedVersion and only one succeeds.', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::AC05', 'Concurrent moves use expectedVersion and only one succeeds.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/01-spaces-and-hierarchy::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
