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

describe('CRM communications contract', () => {
  it('allows multiple communications of the same type', async () => {
    contract('multiple communication values');
  });

  it('enforces one primary per entity and communication type', async () => {
    contract('communication primary uniqueness');
  });

  it('uses same-workspace parent validation', async () => {
    contract('communication workspace isolation');
  });

  it('uses normalized phone/email forms for duplicate matching without auto-merging', async () => {
    contract('communication duplicate normalization');
  });

});

export {};
