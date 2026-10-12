/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Pricing, Promotions, Coupons and Tax Snapshot — unit/integration contract', () => {
  it('exclusive and inclusive taxes produce deterministic totals', async () => { contract('exclusive and inclusive taxes produce deterministic totals'); });
  it('coupon expired/redeemed beyond limit rejected', async () => { contract('coupon expired/redeemed beyond limit rejected'); });
  it('concurrent last-use coupon applies at most once', async () => { contract('concurrent last-use coupon applies at most once'); });
  it('noncombinable rule blocks conflicting discount stack', async () => { contract('noncombinable rule blocks conflicting discount stack'); });
  it('free shipping reduces delivery total and records promotion', async () => { contract('free shipping reduces delivery total and records promotion'); });
  it('promotion change never alters historical paid Order', async () => { contract('promotion change never alters historical paid Order'); });
  it('public coupon probing rate-limited and does not disclose other customer info', async () => { contract('public coupon probing rate-limited and does not disclose other customer info'); });
});
