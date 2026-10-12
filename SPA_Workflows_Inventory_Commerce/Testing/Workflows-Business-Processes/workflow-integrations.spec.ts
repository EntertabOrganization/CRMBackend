/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Domain Actions, HTTP/Webhooks and Secrets — unit/integration contract', () => {
  it('workflow action cannot modify SPA field starter cannot edit', async () => { contract('workflow action cannot modify SPA field starter cannot edit'); });
  it('HTTP node cannot reach 127.0.0.1 or cloud metadata services', async () => { contract('HTTP node cannot reach 127.0.0.1 or cloud metadata services'); });
  it('workflow configuration never serializes plaintext integration secret', async () => { contract('workflow configuration never serializes plaintext integration secret'); });
  it('unauthorized callback or replay cannot resume node', async () => { contract('unauthorized callback or replay cannot resume node'); });
  it('successful callback resumes correct waiting execution once', async () => { contract('successful callback resumes correct waiting execution once'); });
  it('HTTP provider 429 retries according bounded policy and does not double-write', async () => { contract('HTTP provider 429 retries according bounded policy and does not double-write'); });
  it('same node retry reuses idempotency effect key', async () => { contract('same node retry reuses idempotency effect key'); });
});
