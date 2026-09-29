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

describe('KPI/schedule/BI unit contract', () => {
  it('stores KPI target as first-class reusable object', async () => {
    contract('KPI target model');
  });
  it('validates target unit/currency/subject compatibility', async () => {
    contract('KPI validation');
  });
  it('uses Metric Registry semantics for achievement calculation', async () => {
    contract('KPI metric consistency');
  });
  it('stores BI credential metadata without raw reusable secret', async () => {
    contract('BI credential security');
  });
  it('enforces allowed dataset list on BI access', async () => {
    contract('BI dataset scope');
  });
});
