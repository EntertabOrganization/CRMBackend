/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Durable Timers, Events, Parallelism and Bounded Loops — unit/integration contract', () => {
  it('same timer tick delivered twice unblocks node once', async () => { contract('same timer tick delivered twice unblocks node once'); });
  it('unrelated event correlation key does not resume workflow', async () => { contract('unrelated event correlation key does not resume workflow'); });
  it('parallel ALL join does not proceed early', async () => { contract('parallel ALL join does not proceed early'); });
  it('EVENT_RACE winner cancels losing branches', async () => { contract('EVENT_RACE winner cancels losing branches'); });
  it('nested FOR_EACH/WHILE stop at safety limit', async () => { contract('nested FOR_EACH/WHILE stop at safety limit'); });
  it('runtime configuration refuses exceeding platform ceilings', async () => { contract('runtime configuration refuses exceeding platform ceilings'); });
  it('suspend relative timer preserves remaining duration across restart', async () => { contract('suspend relative timer preserves remaining duration across restart'); });
  it('DST and business-day waits do not depend on server timezone', async () => { contract('DST and business-day waits do not depend on server timezone'); });
});

export {};
