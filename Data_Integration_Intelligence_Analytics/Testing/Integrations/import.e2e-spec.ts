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

describe('Interactive import E2E contract', () => {
  it('requires current preview before user-driven import start', async () => {
    contract('preview gate');
  });
  it('preview reconciles predicted create/update/skip/error/warning counts', async () => {
    contract('preview totals');
  });
  it('partial success keeps valid rows and reports invalid rows', async () => {
    contract('partial success');
  });
  it('cancellation stops new row claims without rolling back committed rows', async () => {
    contract('import cancellation');
  });
  it('records job and row provenance to affected records/history', async () => {
    contract('import provenance');
  });
  it('uses Idempotency-Key so retrying start does not start a second import', async () => {
    contract('import start idempotency');
  });
});
