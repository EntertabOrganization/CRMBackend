import { contract } from '../harness';

describe('Integration synchronization E2E contract', () => {
  it('supports adapter-declared push/pull/bidirectional modes', async () => {
    await contract('sync direction capabilities');
  });
  it('persists stable internal-external links', async () => {
    await contract('external mapping');
  });
  it('advances checkpoint only after successful range processing', async () => {
    await contract('safe checkpoint');
  });
  it('resumes retry from prior checkpoint without duplicating writes', async () => {
    await contract('sync resume idempotency');
  });
  it('prevents bidirectional echo loops for logically identical changes', async () => {
    await contract('sync loop prevention');
  });
  it('moves connection to auth-required/degraded without deleting data on credential failure', async () => {
    await contract('sync auth failure');
  });
});
