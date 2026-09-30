import { contract } from '../harness';

describe('CRM merge E2E contract', () => {
  it('rejects mixed entity types', async () => {
    await contract('same-type merge invariant');
  });
  it('rejects any source record outside active workspace', async () => {
    await contract('merge tenant isolation');
  });
  it('requires merge permission and source-record mutation rights for every source', async () => {
    await contract('merge authorization');
  });
  it('fails execution when source version changed after preview', async () => {
    await contract('stale preview protection');
  });
  it('preserves the chosen survivor and retires merged-away IDs', async () => {
    await contract('survivor semantics');
  });
  it('preserves all distinct valid multi-value communications', async () => {
    await contract('multi-value union');
  });
  it('rolls back local mutations when a required relation rebind fails', async () => {
    await contract('merge transaction rollback');
  });
  it('creates merge evidence, redirect, audit and outbox atomically', async () => {
    await contract('merge evidence atomicity');
  });
  it('serializes or rejects overlapping concurrent merges safely', async () => {
    await contract('merge concurrency');
  });
});
