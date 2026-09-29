export {};

/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Cross-module jobs/idempotency contract', () => {
  it('job retries do not duplicate domain side effects', async () => {
    contract('job retry idempotency');
  });
  it('default retry/dead-letter policy is observable', async () => {
    contract('job retry state');
  });
  it('checkpointed job resumes from safe checkpoint', async () => {
    contract('job checkpoint resume');
  });
  it('same Idempotency-Key with same request returns original result', async () => {
    contract('idempotent replay');
  });
  it('same Idempotency-Key with materially different request conflicts', async () => {
    contract('idempotency fingerprint conflict');
  });
  it('workspace/provider/job concurrency limit is enforced', async () => {
    contract('job concurrency control');
  });
});
