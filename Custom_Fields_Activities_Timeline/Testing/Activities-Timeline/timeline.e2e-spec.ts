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


describe('Timeline E2E contract', () => {
  it('returns only timeline data for a CRM record the caller is authorized to read', async () => {
    contract('timeline record authorization');
  });

  it('paginates with cursor without duplicates/gaps across equal occurredAt timestamps', async () => {
    contract('timeline cursor E2E');
  });

  it('filters by category/actor/date/source type using allowlisted query fields', async () => {
    contract('timeline filters');
  });

  it('does not duplicate an entry when an outbox event is delivered twice', async () => {
    contract('timeline retry idempotency E2E');
  });

  it('creates a comment with stable mention IDs and shared file references', async () => {
    contract('timeline comment E2E');
  });

  it('soft deletes a comment and preserves audit/history evidence', async () => {
    contract('timeline comment delete E2E');
  });
});
