import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/03-conversations-messages-and-retention.md. These are fail-closed executable contracts, not mocks.
describe('AI conversations, messages, privacy and retention [repository contracts]', () => {
  it('AC01: No-history run produces usage audit but no readable conversation transcript.', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::AC01', 'No-history run produces usage audit but no readable conversation transcript.', 'INTEGRATION');
  });
  it('AC02: Unauthorized colleague cannot fetch thread by UUID.', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::AC02', 'Unauthorized colleague cannot fetch thread by UUID.', 'INTEGRATION');
  });
  it('AC03: Deleting thread under legal hold is held with explainable status.', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::AC03', 'Deleting thread under legal hold is held with explainable status.', 'INTEGRATION');
  });
  it('AC04: Duplicate message idempotency prevents duplicate provider requests.', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::AC04', 'Duplicate message idempotency prevents duplicate provider requests.', 'INTEGRATION');
  });
  it('AC05: Workspace switch cannot display other tenant conversations.', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::AC05', 'Workspace switch cannot display other tenant conversations.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/03-conversations-messages-and-retention::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
