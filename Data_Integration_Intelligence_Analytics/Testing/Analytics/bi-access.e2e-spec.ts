import { contract } from '../harness';

describe('External BI access E2E contract', () => {
  it('never returns production database credentials', async () => {
    await contract('BI database isolation');
  });
  it('scopes BI credential to one workspace/service identity', async () => {
    await contract('BI tenant scope');
  });
  it('rejects unapproved dataset', async () => {
    await contract('BI dataset authorization');
  });
  it('applies rate/query limits', async () => {
    await contract('BI limits');
  });
  it('revocation prevents future queries', async () => {
    await contract('BI credential revocation');
  });
  it('enforces current data permission policy', async () => {
    await contract('BI permission filtering');
  });
});
