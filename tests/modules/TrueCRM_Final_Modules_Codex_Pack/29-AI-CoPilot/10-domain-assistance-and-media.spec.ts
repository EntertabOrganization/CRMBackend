import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/10-domain-assistance-and-media.md. These are fail-closed executable contracts, not mocks.
describe('Domain assistants, extraction and media generation [repository contracts]', () => {
  it('AC01: Invalid extraction never updates CRM.', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::AC01', 'Invalid extraction never updates CRM.', 'INTEGRATION');
  });
  it('AC02: Unauthorized File cannot be transcribed.', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::AC02', 'Unauthorized File cannot be transcribed.', 'INTEGRATION');
  });
  it('AC03: Editing target after extraction causes version conflict on apply.', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::AC03', 'Editing target after extraction causes version conflict on apply.', 'INTEGRATION');
  });
  it('AC04: Generated campaign cannot send without Marketing approval.', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::AC04', 'Generated campaign cannot send without Marketing approval.', 'INTEGRATION');
  });
  it('AC05: Unsafe generated image quarantined and cannot be shared.', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::AC05', 'Unsafe generated image quarantined and cannot be shared.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/10-domain-assistance-and-media::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
