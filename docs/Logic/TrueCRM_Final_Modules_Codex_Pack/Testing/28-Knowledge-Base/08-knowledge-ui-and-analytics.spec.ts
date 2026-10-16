import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/08-knowledge-ui-and-analytics.md. These are fail-closed executable contracts, not mocks.
describe('Knowledge interface, analytics and administration [repository contracts]', () => {
  it('AC01: Shared-with-me becomes empty when grant revoked.', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::AC01', 'Shared-with-me becomes empty when grant revoked.', 'INTEGRATION');
  });
  it('AC02: Search and article detail cannot be opened by unauthorized reader.', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::AC02', 'Search and article detail cannot be opened by unauthorized reader.', 'INTEGRATION');
  });
  it('AC03: Article report counts reconcile to read dedupe definition.', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::AC03', 'Article report counts reconcile to read dedupe definition.', 'INTEGRATION');
  });
  it('AC04: Keyboard-only users can navigate tree and editor.', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::AC04', 'Keyboard-only users can navigate tree and editor.', 'INTEGRATION');
  });
  it('AC05: Workspace swap does not leak knowledge favorites.', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::AC05', 'Workspace swap does not leak knowledge favorites.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/08-knowledge-ui-and-analytics::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
