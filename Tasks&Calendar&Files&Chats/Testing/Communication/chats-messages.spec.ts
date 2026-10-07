/**
 * TrueCRM executable contract test for Chats & Messages Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Chats & Messages Specification contract', () => {
  it('Duplicate send.', async () => {
    contract('Duplicate send.');
  });
  it('Missed realtime then reload.', async () => {
    contract('Missed realtime then reload.');
  });
  it('Remove one of multiple membership sources.', async () => {
    contract('Remove one of multiple membership sources.');
  });
  it('Task Chat bypass attempt.', async () => {
    contract('Task Chat bypass attempt.');
  });
  it('Edit/delete expiry.', async () => {
    contract('Edit/delete expiry.');
  });
  it('Cross-workspace direct Chat.', async () => {
    contract('Cross-workspace direct Chat.');
  });
});
