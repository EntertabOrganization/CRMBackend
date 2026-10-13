/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Lead conversion E2E contract', () => {
  it('converts to a new Contact without requiring a Deal', async () => {
    contract('lead conversion contact only');
  });

  it('converts to a new Company without requiring a Deal', async () => {
    contract('lead conversion company only');
  });

  it('creates or links Contact and Company and optionally creates a Deal atomically', async () => {
    contract('lead conversion mixed outputs');
  });

  it('never silently chooses a duplicate customer record', async () => {
    contract('lead conversion duplicate intent');
  });

  it('rolls back all created records when conversion transaction fails', async () => {
    contract('lead conversion atomic rollback');
  });

  it('preserves Lead and conversion history after success', async () => {
    contract('lead conversion history');
  });

  it('rejects a second independent conversion with CRM_ALREADY_CONVERTED', async () => {
    contract('lead conversion one-time');
  });

  it('returns the original result for an identical Idempotency-Key retry', async () => {
    contract('lead conversion idempotency');
  });

});

export {};
