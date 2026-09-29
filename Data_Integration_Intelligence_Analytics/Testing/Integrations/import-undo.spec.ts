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

describe('Import undo contract', () => {
  it('allows reversal only when post-import state is still safe', async () => {
    contract('safe undo eligibility');
  });
  it('refuses to delete imported record with protected subsequent business activity', async () => {
    contract('unsafe created-record undo');
  });
  it('refuses to overwrite a field changed after import', async () => {
    contract('post-import concurrent change');
  });
  it('reports partial/row-level undo outcomes without pretending full rollback', async () => {
    contract('partial undo reporting');
  });
  it('audits executed/refused undo actions', async () => {
    contract('import undo audit');
  });
});
