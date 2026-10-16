import { verifyContractCase } from '../_harness/adapter';

describe('28-Knowledge-Base [full integration E2E]', () => {
  it('E01: Create scoped space, nested article, save and approve a revision, publish; read exact published version', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E01', 'Create scoped space, nested article, save and approve a revision, publish; read exact published version', 'E2E');
  });
  it('E02: Concurrent editors on same baseline receive version-conflict without loss of work', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E02', 'Concurrent editors on same baseline receive version-conflict without loss of work', 'E2E');
  });
  it('E03: An article moved into restricted space disappears from search and AI retrieval despite stale index', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E03', 'An article moved into restricted space disappears from search and AI retrieval despite stale index', 'E2E');
  });
  it('E04: Guest receives expiring read link to one article, cannot browse sibling knowledge, later revoked', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E04', 'Guest receives expiring read link to one article, cannot browse sibling knowledge, later revoked', 'E2E');
  });
  it('E05: Publish HR policy and collect version-specific employee acknowledgement, reject impersonation', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E05', 'Publish HR policy and collect version-specific employee acknowledgement, reject impersonation', 'E2E');
  });
  it('E06: Archive -> recycle -> restore returns original archived state; legal hold blocks purge', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E06', 'Archive -> recycle -> restore returns original archived state; legal hold blocks purge', 'E2E');
  });
  it('E07: Import hostile HTML; sanitizer prevents script execution and keeps row-level error report', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E07', 'Import hostile HTML; sanitizer prevents script execution and keeps row-level error report', 'E2E');
  });
  it('E08: Switch Workspace context: prior knowledge, favorites and index results do not leak', async () => {
    await verifyContractCase('28-Knowledge-Base/JOURNEY::E08', 'Switch Workspace context: prior knowledge, favorites and index results do not leak', 'E2E');
  });
});
