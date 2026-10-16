import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/01-provider-connections-and-model-routing.md. These are fail-closed executable contracts, not mocks.
describe('Provider connections, model catalog and secure routing [repository contracts]', () => {
  it('AC01: Fallback to disallowed regional model fails closed.', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::AC01', 'Fallback to disallowed regional model fails closed.', 'INTEGRATION');
  });
  it('AC02: BYOK key never appears in logs/GET.', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::AC02', 'BYOK key never appears in logs/GET.', 'INTEGRATION');
  });
  it('AC03: Suspending connection prevents new runs.', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::AC03', 'Suspending connection prevents new runs.', 'INTEGRATION');
  });
  it('AC04: Capability mismatch rejects route before charging.', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::AC04', 'Capability mismatch rejects route before charging.', 'INTEGRATION');
  });
  it('AC05: Model price change does not rewrite historical usage costs.', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::AC05', 'Model price change does not rewrite historical usage costs.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/01-provider-connections-and-model-routing::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
