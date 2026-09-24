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


describe('Frontend - Activities & Timeline contract', () => {
  it('defaults global Activities to My Open Activities with overdue surfaced first', async () => {
    contract('default global activities view');
  });

  it('renders List and Deadline Board groups Overdue/Today/Upcoming/Later/No Deadline/Completed', async () => {
    contract('deadline board');
  });

  it('creates an Activity from CRM context with current CRM record prebound', async () => {
    contract('activity create from CRM UI');
  });

  it('shows completed/cancelled business fields read-only until explicit reopen', async () => {
    contract('activity completed UX');
  });

  it('reports bulk partial failures instead of showing whole-operation success', async () => {
    contract('bulk partial result UI');
  });

  it('never displays unauthorized Activity bindings returned/redacted by server policy', async () => {
    contract('binding disclosure UI');
  });

  it('renders Timeline cursor pages and realtime entries without duplicates', async () => {
    contract('timeline realtime dedupe UI');
  });

  it('supports comment files/mentions/edit/soft-delete according to permissions', async () => {
    contract('timeline comment UI');
  });

  it('delegates Meeting/Task advanced UX to specialist modules instead of inventing duplicate controls', async () => {
    contract('specialist adapter UI boundary');
  });
});
