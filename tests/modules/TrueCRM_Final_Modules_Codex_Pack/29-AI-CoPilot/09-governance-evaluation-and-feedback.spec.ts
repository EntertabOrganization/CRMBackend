import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/09-governance-evaluation-and-feedback.md. These are fail-closed executable contracts, not mocks.
describe('AI safety, evaluations, feedback and governance [repository contracts]', () => {
  it('AC01: Feedback on another tenant run rejected.', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::AC01', 'Feedback on another tenant run rejected.', 'INTEGRATION');
  });
  it('AC02: Sensitive prompt not written into centralized log.', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::AC02', 'Sensitive prompt not written into centralized log.', 'INTEGRATION');
  });
  it('AC03: Evaluation detects unrestricted tool proposal.', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::AC03', 'Evaluation detects unrestricted tool proposal.', 'INTEGRATION');
  });
  it('AC04: Disabled scenario blocks new runs but preserves review records.', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::AC04', 'Disabled scenario blocks new runs but preserves review records.', 'INTEGRATION');
  });
  it('AC05: Policy change is versioned and traceable.', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::AC05', 'Policy change is versioned and traceable.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/09-governance-evaluation-and-feedback::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
