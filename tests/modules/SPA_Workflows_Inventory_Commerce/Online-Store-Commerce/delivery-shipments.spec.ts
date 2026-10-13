/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Delivery Methods, Shipment Lifecycle and Fulfillment — unit/integration contract', () => {
  it('10 units shipped 6+4 from two warehouses completes fulfillment only when both delivered/qualify', async () => { contract('10 units shipped 6+4 from two warehouses completes fulfillment only when both delivered/qualify'); });
  it('shipment quantity greater than unfulfilled order quantity rejected', async () => { contract('shipment quantity greater than unfulfilled order quantity rejected'); });
  it('ship before payment blocked except configured COD/credit policy', async () => { contract('ship before payment blocked except configured COD/credit policy'); });
  it('stock deduction failure leaves shipment not SHIPPED', async () => { contract('stock deduction failure leaves shipment not SHIPPED'); });
  it('same ship idempotency key does not duplicate stock movement', async () => { contract('same ship idempotency key does not duplicate stock movement'); });
  it('invalid delivery provider signature ignored without state mutation', async () => { contract('invalid delivery provider signature ignored without state mutation'); });
  it('shipment event outside Store workspace denied', async () => { contract('shipment event outside Store workspace denied'); });
  it('pre-ship cancel releases reservations, post-ship requires Return', async () => { contract('pre-ship cancel releases reservations, post-ship requires Return'); });
});

export {};
