import { verifyContractCase } from '../_harness/adapter';

// Source spec: 30-Platform-Services/05-global-search-recents-and-favorites.md. These are fail-closed executable contracts, not mocks.
describe('ACL-safe global search and derived personal views [repository contracts]', () => {
  it('AC01: A private Knowledge hit is hidden even with stale index.', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::AC01', 'A private Knowledge hit is hidden even with stale index.', 'INTEGRATION');
  });
  it('AC02: Index rebuild returns equivalent authorized results.', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::AC02', 'Index rebuild returns equivalent authorized results.', 'INTEGRATION');
  });
  it('AC03: Favorite becomes invisible after access loss.', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::AC03', 'Favorite becomes invisible after access loss.', 'INTEGRATION');
  });
  it('AC04: Search with crafted cross-tenant ID cannot access data.', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::AC04', 'Search with crafted cross-tenant ID cannot access data.', 'INTEGRATION');
  });
  it('AC05: Deleted source removed from index on reconciliation.', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::AC05', 'Deleted source removed from index on reconciliation.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('30-Platform-Services/05-global-search-recents-and-favorites::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
