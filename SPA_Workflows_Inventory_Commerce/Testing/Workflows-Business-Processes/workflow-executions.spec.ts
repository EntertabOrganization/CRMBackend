/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Executions, Tokens, Dispatch and Recovery — unit/integration contract', () => {
  it('same Idempotency-Key returns one execution across retries', async () => { contract('same Idempotency-Key returns one execution across retries'); });
  it('second default concurrent execution same entity+definition rejected', async () => { contract('second default concurrent execution same entity+definition rejected'); });
  it('run remains pinned to initial published version across later publish', async () => { contract('run remains pinned to initial published version across later publish'); });
  it('worker crash after checkpoint resumes without duplicate node side effects', async () => { contract('worker crash after checkpoint resumes without duplicate node side effects'); });
  it('parallel join completes only after configured branch condition', async () => { contract('parallel join completes only after configured branch condition'); });
  it('stale execution expectedVersion returns conflict', async () => { contract('stale execution expectedVersion returns conflict'); });
  it('suspended execution has no node dispatch and resumes correctly', async () => { contract('suspended execution has no node dispatch and resumes correctly'); });
  it('unauthorized user cannot inspect sensitive variables or logs', async () => { contract('unauthorized user cannot inspect sensitive variables or logs'); });
});
