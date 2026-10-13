/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Inventory Documents, Approval, Posting and Reversal — unit/integration contract', () => {
  it('draft creation does not change stock', async () => { contract('draft creation does not change stock'); });
  it('post receipt generates one movement per line and adjusts balance', async () => { contract('post receipt generates one movement per line and adjusts balance'); });
  it('cannot post transfer with only source warehouse access', async () => { contract('cannot post transfer with only source warehouse access'); });
  it('simultaneous process same document posts once via idempotency', async () => { contract('simultaneous process same document posts once via idempotency'); });
  it('post failure rolls back both transfer legs, history and outbox', async () => { contract('post failure rolls back both transfer legs, history and outbox'); });
  it('processed line cannot be updated/deleted', async () => { contract('processed line cannot be updated/deleted'); });
  it('approval-required write-off cannot skip approval', async () => { contract('approval-required write-off cannot skip approval'); });
  it('reverse receipt cannot overdraw source stock and never deletes original movements', async () => { contract('reverse receipt cannot overdraw source stock and never deletes original movements'); });
});

export {};
