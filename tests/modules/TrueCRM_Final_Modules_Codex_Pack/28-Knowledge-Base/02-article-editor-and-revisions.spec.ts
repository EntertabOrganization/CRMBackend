import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/02-article-editor-and-revisions.md. These are fail-closed executable contracts, not mocks.
describe('Article editor, structured content and revisions [repository contracts]', () => {
  it('AC01: Two concurrent editors update same baseline: one succeeds, other receives 409 without losing changes.', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::AC01', 'Two concurrent editors update same baseline: one succeeds, other receives 409 without losing changes.', 'INTEGRATION');
  });
  it('AC02: Draft update does not mutate published content.', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::AC02', 'Draft update does not mutate published content.', 'INTEGRATION');
  });
  it('AC03: Unsafe script/embedded arbitrary HTML is rejected or sanitized and cannot execute in preview.', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::AC03', 'Unsafe script/embedded arbitrary HTML is rejected or sanitized and cannot execute in preview.', 'INTEGRATION');
  });
  it('AC04: File attachment inaccessible despite article grant when File ACL denies access.', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::AC04', 'File attachment inaccessible despite article grant when File ACL denies access.', 'INTEGRATION');
  });
  it('AC05: Reverting a revision creates a new latest revision retaining audit chain.', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::AC05', 'Reverting a revision creates a new latest revision retaining audit chain.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/02-article-editor-and-revisions::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
