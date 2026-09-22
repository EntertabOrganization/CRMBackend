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

describe('Lead contract', () => {
  it('creates a Lead in the default LEAD pipeline/default PROGRESS stage when omitted', async () => {
    contract('lead default pipeline and stage');
  });

  it('allows explicit LEAD pipeline selection but rejects a DEAL pipeline', async () => {
    contract('lead pipeline entity type isolation');
  });

  it('defaults responsible user to the authenticated user', async () => {
    contract('lead default responsible user');
  });

  it('supports estimated amount, currency, source, address, UTM and origin metadata', async () => {
    contract('lead commercial and acquisition fields');
  });

  it('allows links to existing same-workspace customer records without converting', async () => {
    contract('returning customer lead');
  });

  it('does not auto-convert when entering a SUCCESS stage', async () => {
    contract('lead success is not conversion');
  });

  it('rejects stale mutation with CRM_VERSION_CONFLICT', async () => {
    contract('lead optimistic concurrency');
  });

});
