import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/05-search-ai-indexing-and-citations.md. These are fail-closed executable contracts, not mocks.
describe('Knowledge search, indexing and AI citations [repository contracts]', () => {
  it('AC01: After article access revocation, stale index cannot return title or excerpt.', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::AC01', 'After article access revocation, stale index cannot return title or excerpt.', 'INTEGRATION');
  });
  it('AC02: Unpublished draft never appears in AI retrieval.', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::AC02', 'Unpublished draft never appears in AI retrieval.', 'INTEGRATION');
  });
  it('AC03: AI disabled on space prevents all chunks including old indexed chunks.', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::AC03', 'AI disabled on space prevents all chunks including old indexed chunks.', 'INTEGRATION');
  });
  it('AC04: Repeated reindex keeps one active projection per published revision.', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::AC04', 'Repeated reindex keeps one active projection per published revision.', 'INTEGRATION');
  });
  it('AC05: Citation references exact revision used for answer.', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::AC05', 'Citation references exact revision used for answer.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/05-search-ai-indexing-and-citations::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
