/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Returns, Disposition, Refunds and Financial Approval — unit/integration contract', () => {
  it('return requested quantity cannot exceed delivered minus already returned', async () => { contract('return requested quantity cannot exceed delivered minus already returned'); });
  it('received damaged unit not added to sellable stock', async () => { contract('received damaged unit not added to sellable stock'); });
  it('returned units create correct Inventory return document exactly once', async () => { contract('returned units create correct Inventory return document exactly once'); });
  it('partial refund does not modify original Payment amount', async () => { contract('partial refund does not modify original Payment amount'); });
  it('refund above captured available amount rejected', async () => { contract('refund above captured available amount rejected'); });
  it('same provider refund webhook/retry does not duplicate money refund', async () => { contract('same provider refund webhook/retry does not duplicate money refund'); });
  it('creator without REFUND_APPROVE cannot self-approve above threshold', async () => { contract('creator without REFUND_APPROVE cannot self-approve above threshold'); });
  it('refund success can exist without physical Return only under allowed policy', async () => { contract('refund success can exist without physical Return only under allowed policy'); });
});

export {};
