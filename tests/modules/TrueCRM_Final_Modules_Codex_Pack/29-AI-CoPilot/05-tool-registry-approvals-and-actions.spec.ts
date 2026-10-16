import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/05-tool-registry-approvals-and-actions.md. These are fail-closed executable contracts, not mocks.
describe('AI tool registry, approvals and business actions [repository contracts]', () => {
  it('AC01: High-risk refund tool cannot execute with Allow Always.', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::AC01', 'High-risk refund tool cannot execute with Allow Always.', 'INTEGRATION');
  });
  it('AC02: Changing args after approval returns 409 APPROVAL_STALE.', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::AC02', 'Changing args after approval returns 409 APPROVAL_STALE.', 'INTEGRATION');
  });
  it('AC03: Missing domain permission denies action even if user approved.', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::AC03', 'Missing domain permission denies action even if user approved.', 'INTEGRATION');
  });
  it('AC04: Duplicated worker delivery creates exactly one business mutation.', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::AC04', 'Duplicated worker delivery creates exactly one business mutation.', 'INTEGRATION');
  });
  it('AC05: Revoked approval blocks pending call.', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::AC05', 'Revoked approval blocks pending call.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/05-tool-registry-approvals-and-actions::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
