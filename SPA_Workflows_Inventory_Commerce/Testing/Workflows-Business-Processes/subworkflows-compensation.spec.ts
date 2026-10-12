/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Subworkflows, Error Routing and Saga Compensation — unit/integration contract', () => {
  it('A->B->A recursion rejected at configured depth/ancestry', async () => { contract('A->B->A recursion rejected at configured depth/ancestry'); });
  it('parent wait child completion maps result correctly', async () => { contract('parent wait child completion maps result correctly'); });
  it('nonwaiting parent does not block on child', async () => { contract('nonwaiting parent does not block on child'); });
  it('cancellation compensates reserved stock exactly once', async () => { contract('cancellation compensates reserved stock exactly once'); });
  it('failed refund compensation retains retryable failure evidence', async () => { contract('failed refund compensation retains retryable failure evidence'); });
  it('compensation without declared inverse action is rejected', async () => { contract('compensation without declared inverse action is rejected'); });
  it('simulated provider timeout cannot double-send refund on retry', async () => { contract('simulated provider timeout cannot double-send refund on retry'); });
});
