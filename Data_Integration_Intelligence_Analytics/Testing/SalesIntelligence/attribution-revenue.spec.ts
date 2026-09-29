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

describe('Attribution revenue basis contract', () => {
  it('keeps customer acquisition source distinct from Deal opportunity source', async () => {
    contract('source distinction');
  });
  it('supports Won Deal revenue basis', async () => {
    contract('won revenue attribution');
  });
  it('supports Paid/Collected revenue basis and excludes pending/failed payments', async () => {
    contract('paid revenue attribution');
  });
  it('uses historical currency conversion for reporting value', async () => {
    contract('attribution FX snapshot');
  });
  it('preserves separate Deals when customer records merge', async () => {
    contract('merge attribution interaction');
  });
});
