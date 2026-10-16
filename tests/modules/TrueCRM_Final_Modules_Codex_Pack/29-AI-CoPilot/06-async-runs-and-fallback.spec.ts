import { verifyContractCase } from '../_harness/adapter';

// Source spec: 29-AI-CoPilot/06-async-runs-and-fallback.md. These are fail-closed executable contracts, not mocks.
describe('Asynchronous AI runs, retries and cancellation [repository contracts]', () => {
  it('AC01: Repeated submit key creates one run.', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::AC01', 'Repeated submit key creates one run.', 'INTEGRATION');
  });
  it('AC02: Cancellation releases unused reserved credits but retains consumed usage.', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::AC02', 'Cancellation releases unused reserved credits but retains consumed usage.', 'INTEGRATION');
  });
  it('AC03: Provider timeout never silently double-debits.', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::AC03', 'Provider timeout never silently double-debits.', 'INTEGRATION');
  });
  it('AC04: Fallback respects residency and spend cap.', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::AC04', 'Fallback respects residency and spend cap.', 'INTEGRATION');
  });
  it('AC05: Worker restart resumes durable state and terminal run remains terminal.', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::AC05', 'Worker restart resumes durable state and terminal run remains terminal.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('29-AI-CoPilot/06-async-runs-and-fallback::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
