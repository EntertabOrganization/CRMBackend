import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/02-scenarios-prompts-and-assistants.md. These are fail-closed executable contracts, not mocks.
describe('AI scenario registry, prompt versions and assistants [repository contracts]', () => {
  it('AC01: Unprivileged user cannot enable HR-sensitive AI.', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::AC01', 'Unprivileged user cannot enable HR-sensitive AI.', 'INTEGRATION');
  });
  it('AC02: Prompt v1 run is unaffected by v2 publication.', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::AC02', 'Prompt v1 run is unaffected by v2 publication.', 'INTEGRATION');
  });
  it('AC03: Assistant cannot call tool outside configured policy.', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::AC03', 'Assistant cannot call tool outside configured policy.', 'INTEGRATION');
  });
  it('AC04: Invalid structured extraction is rejected without creating CRM fields.', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::AC04', 'Invalid structured extraction is rejected without creating CRM fields.', 'INTEGRATION');
  });
  it('AC05: Prompt injection inside retrieved article cannot override module permissions.', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::AC05', 'Prompt injection inside retrieved article cannot override module permissions.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/02-scenarios-prompts-and-assistants::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
