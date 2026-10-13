/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce Payments, Authorization, Capture and Disputes — unit/integration contract', () => {
  it('browser success redirect alone does not mark Payment PAID', async () => { contract('browser success redirect alone does not mark Payment PAID'); });
  it('same provider event ID processed once despite retries', async () => { contract('same provider event ID processed once despite retries'); });
  it('same capture key captures once and cannot exceed authorized amount', async () => { contract('same capture key captures once and cannot exceed authorized amount'); });
  it('split 2000+8000 payments can satisfy 10000 Order', async () => { contract('split 2000+8000 payments can satisfy 10000 Order'); });
  it('failure in provider leaves visible recoverable pending/failed state', async () => { contract('failure in provider leaves visible recoverable pending/failed state'); });
  it('raw card number/CVV never stored', async () => { contract('raw card number/CVV never stored'); });
  it('chargeback creates separate dispute not Return inventory movement', async () => { contract('chargeback creates separate dispute not Return inventory movement'); });
  it('cross-workspace Payment ID inaccessible', async () => { contract('cross-workspace Payment ID inaccessible'); });
});

export {};
