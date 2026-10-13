/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce Customers, Orders, Snapshots and History — unit/integration contract', () => {
  it('catalog price changed after checkout does not rewrite historical order lines', async () => { contract('catalog price changed after checkout does not rewrite historical order lines'); });
  it('Order paid but unfulfilled remains not COMPLETED', async () => { contract('Order paid but unfulfilled remains not COMPLETED'); });
  it('Order fulfilled with COD unpaid stays awaiting required payment unless policy fulfilled', async () => { contract('Order fulfilled with COD unpaid stays awaiting required payment unless policy fulfilled'); });
  it('customer account cannot access another customer’s order', async () => { contract('customer account cannot access another customer’s order'); });
  it('order cancellation after shipped rejected, Return flow suggested', async () => { contract('order cancellation after shipped rejected, Return flow suggested'); });
  it('cancelled Order retains historical payment/shipment refs', async () => { contract('cancelled Order retains historical payment/shipment refs'); });
  it('CRM Deal integration failure does not erase placed Order', async () => { contract('CRM Deal integration failure does not erase placed Order'); });
  it('reorder recalculates current prices and stock', async () => { contract('reorder recalculates current prices and stock'); });
});

export {};
