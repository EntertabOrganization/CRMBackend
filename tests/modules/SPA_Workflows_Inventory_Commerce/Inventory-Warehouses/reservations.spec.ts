/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Stock Reservations, Backorders, Expiry and Allocation — unit/integration contract', () => {
  it('reserve last item from two concurrent requests permits at most available quantity', async () => { contract('reserve last item from two concurrent requests permits at most available quantity'); });
  it('backorder enabled allows reserved greater than onHand but physical issue stays blocked', async () => { contract('backorder enabled allows reserved greater than onHand but physical issue stays blocked'); });
  it('reservation cannot exceed planned sale quantity', async () => { contract('reservation cannot exceed planned sale quantity'); });
  it('release reduces reserved but not onHand', async () => { contract('release reduces reserved but not onHand'); });
  it('expiry runs once despite duplicate timer dispatch', async () => { contract('expiry runs once despite duplicate timer dispatch'); });
  it('partial fulfill reduces reserved and associates sale document', async () => { contract('partial fulfill reduces reserved and associates sale document'); });
  it('same fulfill retry does not reduce stock twice', async () => { contract('same fulfill retry does not reduce stock twice'); });
  it('unauthorized source/warehouse cross-tenant reservation denied', async () => { contract('unauthorized source/warehouse cross-tenant reservation denied'); });
});

export {};
