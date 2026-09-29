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

describe('Data quality rule contract', () => {
  it('rejects arbitrary SQL/executable code in custom quality rules', async () => {
    contract('safe rule expression');
  });
  it('deduplicates repeated findings by rule/entity/evidence fingerprint', async () => {
    contract('finding idempotency');
  });
  it('reconciles finding to resolved/stale when source data is fixed', async () => {
    contract('finding reconciliation');
  });
  it('requires permission and audit for ignore/resolve', async () => {
    contract('finding authorization and audit');
  });
  it('applies only safe configured automatic normalization through CRM services', async () => {
    contract('safe auto-fix');
  });
  it('stores score version and rule-set version', async () => {
    contract('quality score versioning');
  });
  it('does not use quality score alone to block CRM mutation', async () => {
    contract('quality score non-blocking rule');
  });
});
