import { verifyContractCase } from '../_harness/adapter';

describe('TrueCRM Modules 28–32 [cross-module E2E]', () => {
  it('X01: Knowledge published and permission revoked -> AI index no longer returns article, even with stale cache', async () => {
    await verifyContractCase('CROSS::X01', 'Knowledge published and permission revoked -> AI index no longer returns article, even with stale cache', 'E2E');
  });
  it('X02: AI request reserves Billing credits before any external provider call and settles exactly once', async () => {
    await verifyContractCase('CROSS::X02', 'AI request reserves Billing credits before any external provider call and settles exactly once', 'E2E');
  });
  it('X03: AI high-risk action never directly modifies Billing ledger/Partner discount without domain permission', async () => {
    await verifyContractCase('CROSS::X03', 'AI high-risk action never directly modifies Billing ledger/Partner discount without domain permission', 'E2E');
  });
  it('X04: Billing verified settlement creates Partner commission once; replayed webhook creates zero extra accrual', async () => {
    await verifyContractCase('CROSS::X04', 'Billing verified settlement creates Partner commission once; replayed webhook creates zero extra accrual', 'E2E');
  });
  it('X05: Partner transfer changes future quote attribution but not historical invoice or commissions', async () => {
    await verifyContractCase('CROSS::X05', 'Partner transfer changes future quote attribution but not historical invoice or commissions', 'E2E');
  });
  it('X06: Partner-paid subscription fails, customer Workspace retains ownership and can move to direct payer', async () => {
    await verifyContractCase('CROSS::X06', 'Partner-paid subscription fails, customer Workspace retains ownership and can move to direct payer', 'E2E');
  });
  it('X07: Suspending Partner revokes delegated Workspace rights without suspending customer Workspace itself', async () => {
    await verifyContractCase('CROSS::X07', 'Suspending Partner revokes delegated Workspace rights without suspending customer Workspace itself', 'E2E');
  });
  it('X08: Platform outbox retries and DLQ preserve source state, auditing and notifications without duplicate effects', async () => {
    await verifyContractCase('CROSS::X08', 'Platform outbox retries and DLQ preserve source state, auditing and notifications without duplicate effects', 'E2E');
  });
  it('X09: Privacy hold overrides Knowledge purge and AI history erasure while retaining legally required billing audit', async () => {
    await verifyContractCase('CROSS::X09', 'Privacy hold overrides Knowledge purge and AI history erasure while retaining legally required billing audit', 'E2E');
  });
  it('X10: Access downgrade hides unauthorized Knowledge/Partner report details even from search and exported snapshots', async () => {
    await verifyContractCase('CROSS::X10', 'Access downgrade hides unauthorized Knowledge/Partner report details even from search and exported snapshots', 'E2E');
  });
  it('X11: BYOK usage produces audit/cost counters but no platform-funded credit charge under explicit policy', async () => {
    await verifyContractCase('CROSS::X11', 'BYOK usage produces audit/cost counters but no platform-funded credit charge under explicit policy', 'E2E');
  });
  it('X12: Admin emergency support access is purpose-limited and never becomes a normal Partner or Workspace role', async () => {
    await verifyContractCase('CROSS::X12', 'Admin emergency support access is purpose-limited and never becomes a normal Partner or Workspace role', 'E2E');
  });
});
