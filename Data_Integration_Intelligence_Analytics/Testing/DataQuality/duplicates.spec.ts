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

describe('Duplicate detection contract', () => {
  it('normalizes phone/email presentation differences', async () => {
    contract('normalized exact duplicate keys');
  });
  it('detects Lead, Contact and Company duplicates but does not classify Deals as duplicate customers', async () => {
    contract('supported entity boundary');
  });
  it('records match tier, score and explainable evidence', async () => {
    contract('candidate evidence');
  });
  it('never auto-merges a fuzzy-name-only candidate', async () => {
    contract('fuzzy-only automatic merge protection');
  });
  it('suppresses an excluded pair until identity materially changes or exclusion is removed', async () => {
    contract('duplicate exclusion lifecycle');
  });
  it('never creates a candidate across workspace boundaries', async () => {
    contract('duplicate tenant isolation');
  });
  it('creates cross-type warning without enabling cross-type merge', async () => {
    contract('cross-type identity warning');
  });
  it('reprocessing the same source version converges without duplicate candidate rows', async () => {
    contract('candidate idempotency');
  });
});
