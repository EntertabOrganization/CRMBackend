import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/06-import-export-and-templates.md. These are fail-closed executable contracts, not mocks.
describe('Knowledge imports, exports and templates [repository contracts]', () => {
  it('AC01: Untrusted HTML script imported becomes inert.', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::AC01', 'Untrusted HTML script imported becomes inert.', 'INTEGRATION');
  });
  it('AC02: Partial import shows accurate per-row error and no duplicate article after retry.', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::AC02', 'Partial import shows accurate per-row error and no duplicate article after retry.', 'INTEGRATION');
  });
  it('AC03: Export cannot include private sibling article.', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::AC03', 'Export cannot include private sibling article.', 'INTEGRATION');
  });
  it('AC04: Download after access revoked fails despite unexpired URL.', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::AC04', 'Download after access revoked fails despite unexpired URL.', 'INTEGRATION');
  });
  it('AC05: Importing DOCX with corrupted bytes returns field/job error, not partial unsafe content.', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::AC05', 'Importing DOCX with corrupted bytes returns field/job error, not partial unsafe content.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/06-import-export-and-templates::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
