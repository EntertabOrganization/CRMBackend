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


describe('Activities - lifecycle and state', () => {
  it('supports PLANNED -> IN_PROGRESS -> COMPLETED and cancellation paths', async () => {
    contract('activity lifecycle transitions');
  });

  it('supports COMPLETED -> IN_PROGRESS and CANCELLED -> PLANNED only through reopen', async () => {
    contract('activity reopen transitions');
  });

  it('rejects editing completed business fields without reopen', async () => {
    contract('completed activity immutability');
  });

  it('uses LOW/NORMAL/HIGH priority with NORMAL default', async () => {
    contract('activity priority');
  });

  it('validates INCOMING/OUTGOING/NOT_APPLICABLE by activity type', async () => {
    contract('activity direction validation');
  });

  it('validates type-aware start/end/deadline and timestamptz semantics', async () => {
    contract('activity timing');
  });

  it('allows an Activity with no CRM binding', async () => {
    contract('unbound activity');
  });

  it('records optional result text and structured outcome custom fields on completion', async () => {
    contract('activity completion result');
  });

  it('soft deletes/restores Activity without erasing timeline or audit history', async () => {
    contract('activity recycle lifecycle');
  });
});

export {};
