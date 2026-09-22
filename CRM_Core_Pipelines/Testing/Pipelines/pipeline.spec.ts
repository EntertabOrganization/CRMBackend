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

describe('Pipeline contract', () => {
  it('supports multiple LEAD pipelines and multiple DEAL pipelines', async () => {
    contract('multiple pipeline entity types');
  });

  it('enforces one active default pipeline per Workspace and entity type', async () => {
    contract('default pipeline uniqueness');
  });

  it('treats pipeline names case-insensitively within Workspace and entity type', async () => {
    contract('pipeline name uniqueness');
  });

  it('allows the same visible name once for LEAD and once for DEAL', async () => {
    contract('pipeline namespace by entity type');
  });

  it('creates valid default Lead and Deal pipelines for Workspace bootstrap', async () => {
    contract('pipeline bootstrap');
  });

  it('rejects an active pipeline without required semantic structure', async () => {
    contract('pipeline semantic structure');
  });

});
