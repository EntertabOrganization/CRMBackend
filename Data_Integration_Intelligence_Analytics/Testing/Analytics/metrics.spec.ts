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

describe('Metric Registry contract', () => {
  it('published metric version is immutable', async () => {
    contract('metric immutability');
  });
  it('new formula semantics require a new version', async () => {
    contract('metric versioning');
  });
  it('documents event-date and currency basis', async () => {
    contract('metric governance');
  });
  it('equivalent filters using same metric version reconcile across consumers', async () => {
    contract('metric consistency');
  });
  it('won and paid metrics use different correct business dates', async () => {
    contract('metric date semantics');
  });
  it('handles zero/null denominator according to declared policy', async () => {
    contract('metric null/zero policy');
  });
});
