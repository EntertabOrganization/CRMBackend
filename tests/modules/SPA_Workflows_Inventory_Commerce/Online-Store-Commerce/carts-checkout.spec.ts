/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Public Cart, Checkout, Server Prices and Idempotency — unit/integration contract', () => {
  it('public cart token cannot be used across Stores', async () => { contract('public cart token cannot be used across Stores'); });
  it('price tampering browser body rejected/ignored; charged total server computed', async () => { contract('price tampering browser body rejected/ignored; charged total server computed'); });
  it('concurrent same checkout creates exactly one Order', async () => { contract('concurrent same checkout creates exactly one Order'); });
  it('retry with same idempotency key returns prior Order result', async () => { contract('retry with same idempotency key returns prior Order result'); });
  it('stale quote after price change returns re-quote required', async () => { contract('stale quote after price change returns re-quote required'); });
  it('final stock race allows only available purchase when no backorders', async () => { contract('final stock race allows only available purchase when no backorders'); });
  it('failed reservation leaves no falsely confirmed paid Order', async () => { contract('failed reservation leaves no falsely confirmed paid Order'); });
  it('unchecked marketing consent not treated as granted', async () => { contract('unchecked marketing consent not treated as granted'); });
  it('coupon brute force rate-limited', async () => { contract('coupon brute force rate-limited'); });
});

export {};
