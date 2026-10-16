import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/03-acl-sharing-and-external-guests.md. These are fail-closed executable contracts, not mocks.
describe('Knowledge permissions, direct sharing and guests [repository contracts]', () => {
  it('AC01: Direct link does not disclose an article to a different department.', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::AC01', 'Direct link does not disclose an article to a different department.', 'INTEGRATION');
  });
  it('AC02: Guest invitation access is revoked instantly without deleting published article.', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::AC02', 'Guest invitation access is revoked instantly without deleting published article.', 'INTEGRATION');
  });
  it('AC03: Shared-with-me results contain only currently authorized articles.', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::AC03', 'Shared-with-me results contain only currently authorized articles.', 'INTEGRATION');
  });
  it('AC04: Permission change followed by stale search index still returns no unauthorized data.', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::AC04', 'Permission change followed by stale search index still returns no unauthorized data.', 'INTEGRATION');
  });
  it('AC05: Workspace/Article and embedded File permissions are intersected.', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::AC05', 'Workspace/Article and embedded File permissions are intersected.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/03-acl-sharing-and-external-guests::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
