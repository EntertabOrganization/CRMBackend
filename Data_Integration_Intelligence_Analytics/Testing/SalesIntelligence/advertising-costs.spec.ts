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

describe('Marketing cost/provider contract', () => {
  it('uses provider adapters for Google Ads and Meta Ads priorities', async () => {
    contract('ad provider adapter boundary');
  });
  it('deduplicates retried provider cost records', async () => {
    contract('provider cost idempotency');
  });
  it('supports PROVIDER, MANUAL and IMPORT origins', async () => {
    contract('marketing cost origins');
  });
  it('keeps same external campaign IDs isolated by connection/provider', async () => {
    contract('campaign external ID namespace');
  });
  it('preserves original currency and historical FX reference', async () => {
    contract('cost currency history');
  });
  it('does not overwrite TrueCRM attribution with provider-reported conversions', async () => {
    contract('provider metric separation');
  });
  it('shows unresolved source/campaign mapping in cost import preview', async () => {
    contract('cost import mapping');
  });
});
