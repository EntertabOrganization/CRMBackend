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

describe('Traffic source/tracking contract', () => {
  it('resolves source using deterministic evidence precedence', async () => {
    contract('source resolution precedence');
  });
  it('stores explainable rule/version evidence for each touch', async () => {
    contract('source explainability');
  });
  it('supports system and custom online/offline sources', async () => {
    contract('source registry');
  });
  it('records managed tracking-link click and prevents open redirect', async () => {
    contract('tracking link');
  });
  it('maps static tracking number to configured source', async () => {
    contract('static call tracking');
  });
  it('maps supported inbound email alias to source', async () => {
    contract('email source tracking');
  });
  it('manual override remains separate/auditable and does not erase original evidence', async () => {
    contract('source override history');
  });
});
