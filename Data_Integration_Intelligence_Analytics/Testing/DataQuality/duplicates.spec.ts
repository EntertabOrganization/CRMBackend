import { contract } from '../harness';

describe('Duplicate detection contract', () => {
  it('normalizes phone/email presentation differences', async () => {
    await contract('normalized exact duplicate keys');
  });
  it('detects Lead, Contact and Company duplicates but does not classify Deals as duplicate customers', async () => {
    await contract('supported entity boundary');
  });
  it('records match tier, score and explainable evidence', async () => {
    await contract('candidate evidence');
  });
  it('never auto-merges a fuzzy-name-only candidate', async () => {
    await contract('fuzzy-only automatic merge protection');
  });
  it('suppresses an excluded pair until identity materially changes or exclusion is removed', async () => {
    await contract('duplicate exclusion lifecycle');
  });
  it('never creates a candidate across workspace boundaries', async () => {
    await contract('duplicate tenant isolation');
  });
  it('creates cross-type warning without enabling cross-type merge', async () => {
    await contract('cross-type identity warning');
  });
  it('reprocessing the same source version converges without duplicate candidate rows', async () => {
    await contract('candidate idempotency');
  });
});
