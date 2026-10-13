import { contract } from '../harness';

describe('Cross-module jobs/idempotency contract', () => {
  it('job retries do not duplicate domain side effects', async () => {
    await contract('job retry idempotency');
  });
  it('default retry/dead-letter policy is observable', async () => {
    await contract('job retry state');
  });
  it('checkpointed job resumes from safe checkpoint', async () => {
    await contract('job checkpoint resume');
  });
  it('same Idempotency-Key with same request returns original result', async () => {
    await contract('idempotent replay');
  });
  it('same Idempotency-Key with materially different request conflicts', async () => {
    await contract('idempotency fingerprint conflict');
  });
  it('workspace/provider/job concurrency limit is enforced', async () => {
    await contract('job concurrency control');
  });
});
