import { verifyContractCase } from '../_harness/adapter';

describe('29-AI-CoPilot [full integration E2E]', () => {
  it('E01: Configure approved model route and scenario, run infer and settle proper Billing quota', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E01', 'Configure approved model route and scenario, run infer and settle proper Billing quota', 'E2E');
  });
  it('E02: Provider failure only falls back to allowed classification/region/model, otherwise fail safely', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E02', 'Provider failure only falls back to allowed classification/region/model, otherwise fail safely', 'E2E');
  });
  it('E03: Permission-revoked article cannot be retrieved with stale vector index or citation URL', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E03', 'Permission-revoked article cannot be retrieved with stale vector index or citation URL', 'E2E');
  });
  it('E04: Low-risk tool Allow Once acts once; high-risk tool always demands exact-args confirmation', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E04', 'Low-risk tool Allow Once acts once; high-risk tool always demands exact-args confirmation', 'E2E');
  });
  it('E05: MCP external client revocation denies tool before owning domain writes', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E05', 'MCP external client revocation denies tool before owning domain writes', 'E2E');
  });
  it('E06: Two parallel AI runs competing for last credit cannot overdraw quota', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E06', 'Two parallel AI runs competing for last credit cannot overdraw quota', 'E2E');
  });
  it('E07: No-history conversation stores no readable prompt but retains required usage/security evidence', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E07', 'No-history conversation stores no readable prompt but retains required usage/security evidence', 'E2E');
  });
  it('E08: Long AI job survives worker restart, cancellation handles reserved versus consumed usage', async () => {
    await verifyContractCase('29-AI-CoPilot/JOURNEY::E08', 'Long AI job survives worker restart, cancellation handles reserved versus consumed usage', 'E2E');
  });
});
