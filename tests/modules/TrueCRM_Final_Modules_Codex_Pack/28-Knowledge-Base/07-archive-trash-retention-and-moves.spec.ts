import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/07-archive-trash-retention-and-moves.md. These are fail-closed executable contracts, not mocks.
describe('Archive, recycle bin, retention and legal holds [repository contracts]', () => {
  it('AC01: 30-day recycle default retains recoverability; legal hold blocks day-31 purge.', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::AC01', '30-day recycle default retains recoverability; legal hold blocks day-31 purge.', 'INTEGRATION');
  });
  it('AC02: An archived article removed to bin restores archived, not published.', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::AC02', 'An archived article removed to bin restores archived, not published.', 'INTEGRATION');
  });
  it('AC03: AI retrieval stops immediately on recycle despite lagging vector cleanup.', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::AC03', 'AI retrieval stops immediately on recycle despite lagging vector cleanup.', 'INTEGRATION');
  });
  it('AC04: Audit survives permanent purge with sanitized reference.', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::AC04', 'Audit survives permanent purge with sanitized reference.', 'INTEGRATION');
  });
  it('AC05: Unauthorized purge returns 403 and changes nothing.', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::AC05', 'Unauthorized purge returns 403 and changes nothing.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/07-archive-trash-retention-and-moves::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
