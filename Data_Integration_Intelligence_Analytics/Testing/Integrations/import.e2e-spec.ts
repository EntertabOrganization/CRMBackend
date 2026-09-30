import { contract } from '../harness';

describe('Interactive import E2E contract', () => {
  it('requires current preview before user-driven import start', async () => {
    await contract('preview gate');
  });
  it('preview reconciles predicted create/update/skip/error/warning counts', async () => {
    await contract('preview totals');
  });
  it('partial success keeps valid rows and reports invalid rows', async () => {
    await contract('partial success');
  });
  it('cancellation stops new row claims without rolling back committed rows', async () => {
    await contract('import cancellation');
  });
  it('records job and row provenance to affected records/history', async () => {
    await contract('import provenance');
  });
  it('uses Idempotency-Key so retrying start does not start a second import', async () => {
    await contract('import start idempotency');
  });
});
