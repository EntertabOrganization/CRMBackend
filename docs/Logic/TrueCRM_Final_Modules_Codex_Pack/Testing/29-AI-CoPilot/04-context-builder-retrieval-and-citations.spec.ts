import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/04-context-builder-retrieval-and-citations.md. These are fail-closed executable contracts, not mocks.
describe('Permission-aware context, RAG and citations [repository contracts]', () => {
  it('AC01: Revoked knowledge article absent from answer context even with stale vector.', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::AC01', 'Revoked knowledge article absent from answer context even with stale vector.', 'INTEGRATION');
  });
  it('AC02: Citation target cannot be opened by unprivileged viewer.', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::AC02', 'Citation target cannot be opened by unprivileged viewer.', 'INTEGRATION');
  });
  it('AC03: Cross-tenant similar vector never returns content.', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::AC03', 'Cross-tenant similar vector never returns content.', 'INTEGRATION');
  });
  it('AC04: Source prompt injection stays inert user data.', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::AC04', 'Source prompt injection stays inert user data.', 'INTEGRATION');
  });
  it('AC05: Run citations point to correct immutable revision.', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::AC05', 'Run citations point to correct immutable revision.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/04-context-builder-retrieval-and-citations::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
