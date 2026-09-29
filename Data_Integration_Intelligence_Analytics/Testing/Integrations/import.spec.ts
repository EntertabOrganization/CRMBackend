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

describe('Import service contract', () => {
  it('supports CSV and XLSX inputs', async () => {
    contract('supported import formats');
  });
  it('supports CREATE, UPDATE and UPSERT modes', async () => {
    contract('import modes');
  });
  it('rejects invalid field/type mapping before start', async () => {
    contract('mapping validation');
  });
  it('prefers stable internal/external identifiers over fuzzy names', async () => {
    contract('stable matching keys');
  });
  it('delegates duplicate behavior to configured Data Quality policy', async () => {
    contract('duplicate engine reuse');
  });
  it('never links a relationship to another workspace', async () => {
    contract('import relationship tenant isolation');
  });
  it('records one deterministic outcome per processed row', async () => {
    contract('row outcome');
  });
  it('retries/resumes without duplicating committed rows', async () => {
    contract('import checkpoint idempotency');
  });
});
