import { verifyContractCase } from '../_harness/adapter';

// Source spec: 30-Platform-Services/06-audit-security-history-and-support-access.md. These are fail-closed executable contracts, not mocks.
describe('Immutable audit, security events and support access [repository contracts]', () => {
  it('AC01: Platform Admin without support grant cannot fetch tenant private article.', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::AC01', 'Platform Admin without support grant cannot fetch tenant private article.', 'INTEGRATION');
  });
  it('AC02: Critical state mutation rollback has no orphan audit.', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::AC02', 'Critical state mutation rollback has no orphan audit.', 'INTEGRATION');
  });
  it('AC03: Audit cannot be changed or deleted through any API.', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::AC03', 'Audit cannot be changed or deleted through any API.', 'INTEGRATION');
  });
  it('AC04: Expired support grant denies next read.', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::AC04', 'Expired support grant denies next read.', 'INTEGRATION');
  });
  it('AC05: Emergency access produces review and customer-facing trace.', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::AC05', 'Emergency access produces review and customer-facing trace.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('30-Platform-Services/06-audit-security-history-and-support-access::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
