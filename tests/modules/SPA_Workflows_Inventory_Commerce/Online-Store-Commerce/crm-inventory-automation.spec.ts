/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce CRM/Inventory Integration, Cart Abandonment and Events — unit/integration contract', () => {
  it('Deal policy ALWAYS creates exactly one Deal binding per Order', async () => { contract('Deal policy ALWAYS creates exactly one Deal binding per Order'); });
  it('NEVER policy does not create Deals', async () => { contract('NEVER policy does not create Deals'); });
  it('retriable CRM error leaves Order committed and sync status FAILED', async () => { contract('retriable CRM error leaves Order committed and sync status FAILED'); });
  it('reconciliation reports mismatch without rewriting ledgers', async () => { contract('reconciliation reports mismatch without rewriting ledgers'); });
  it('CART_ABANDONED emitted once after 2h default inactivity', async () => { contract('CART_ABANDONED emitted once after 2h default inactivity'); });
  it('cart becomes active again creates new inactivity epoch without duplicate old event', async () => { contract('cart becomes active again creates new inactivity epoch without duplicate old event'); });
  it('marketing notification suppressed when no consent', async () => { contract('marketing notification suppressed when no consent'); });
  it('cross-workspace source binding rejected', async () => { contract('cross-workspace source binding rejected'); });
});

export {};
