import { contract } from '../harness';

describe('Data quality rule contract', () => {
  it('rejects arbitrary SQL/executable code in custom quality rules', async () => {
    await contract('safe rule expression');
  });
  it('deduplicates repeated findings by rule/entity/evidence fingerprint', async () => {
    await contract('finding idempotency');
  });
  it('reconciles finding to resolved/stale when source data is fixed', async () => {
    await contract('finding reconciliation');
  });
  it('requires permission and audit for ignore/resolve', async () => {
    await contract('finding authorization and audit');
  });
  it('applies only safe configured automatic normalization through CRM services', async () => {
    await contract('safe auto-fix');
  });
  it('stores score version and rule-set version', async () => {
    await contract('quality score versioning');
  });
  it('does not use quality score alone to block CRM mutation', async () => {
    await contract('quality score non-blocking rule');
  });
});
