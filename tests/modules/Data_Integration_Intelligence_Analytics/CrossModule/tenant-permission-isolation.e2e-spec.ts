import { contract } from '../harness';

describe('Cross-module tenant and permission isolation contract', () => {
  it('Data Quality cannot expose candidate/quality details for inaccessible CRM record', async () => {
    await contract('data quality permission isolation');
  });
  it('Import/API cannot create relationship across workspaces', async () => {
    await contract('integration tenant isolation');
  });
  it('Sales Intelligence cannot link visitor/touch to customer in another workspace', async () => {
    await contract('tracking tenant isolation');
  });
  it('Analytics shared dashboard never expands source data access', async () => {
    await contract('analytics permission isolation');
  });
  it('changing a payload workspace ID cannot override trusted context', async () => {
    await contract('untrusted workspace input');
  });
  it('permission reduction prevents protected analytics disclosure even before projection refresh', async () => {
    await contract('authorization query-time enforcement');
  });
});
