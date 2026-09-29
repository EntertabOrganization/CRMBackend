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

describe('Visitor identity contract', () => {
  it('creates random workspace-scoped first-party visitor/session identifiers', async () => {
    contract('visitor identifier security');
  });
  it('respects privacy/consent mode before persisting anonymous analytics', async () => {
    contract('tracking privacy policy');
  });
  it('uses deterministic identity linking rather than probabilistic fingerprinting', async () => {
    contract('identity stitching policy');
  });
  it('never links visitor to CRM entity in another workspace', async () => {
    contract('visitor identity tenant isolation');
  });
  it('preserves previous touch history when visitor becomes known', async () => {
    contract('anonymous-to-known history');
  });
});
