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

describe('Semantic report builder E2E contract', () => {
  it('allows only approved semantic datasets/joins', async () => {
    contract('semantic dataset boundary');
  });
  it('rejects arbitrary SQL from normal report user', async () => {
    contract('no arbitrary SQL');
  });
  it('exposes eligible custom fields with correct type behavior', async () => {
    contract('custom field analytics');
  });
  it('validates filters/operators against dataset metadata', async () => {
    contract('report filter validation');
  });
  it('prevents many-to-many double count through grain/join rules', async () => {
    contract('report grain safety');
  });
  it('drill-down reconciles to displayed metric and source permissions', async () => {
    contract('report drill-down');
  });
  it('same shared report returns scope-appropriate results for different users', async () => {
    contract('report permission filtering');
  });
});
