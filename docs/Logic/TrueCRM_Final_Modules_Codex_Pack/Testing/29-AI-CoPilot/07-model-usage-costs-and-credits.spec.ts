import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/07-model-usage-costs-and-credits.md. These are fail-closed executable contracts, not mocks.
describe('AI token accounting, BYOK and credit consumption [repository contracts]', () => {
  it('AC01: Two concurrent AI requests cannot overspend workspace cap.', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::AC01', 'Two concurrent AI requests cannot overspend workspace cap.', 'INTEGRATION');
  });
  it('AC02: Settling less than estimate releases residual reservation.', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::AC02', 'Settling less than estimate releases residual reservation.', 'INTEGRATION');
  });
  it('AC03: Retry with same usage event doesn\'t double-debit credits.', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::AC03', 'Retry with same usage event doesn\'t double-debit credits.', 'INTEGRATION');
  });
  it('AC04: BYOK tokens/cost are reported without platform credit charge.', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::AC04', 'BYOK tokens/cost are reported without platform credit charge.', 'INTEGRATION');
  });
  it('AC05: Price change preserves historical cost snapshot.', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::AC05', 'Price change preserves historical cost snapshot.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/07-model-usage-costs-and-credits::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
