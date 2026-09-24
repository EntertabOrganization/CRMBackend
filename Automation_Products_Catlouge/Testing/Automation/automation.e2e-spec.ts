const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Automation API E2E', () => {
  it('creates, edits and publishes a Rule through API', () => contract('Rule API lifecycle uses stable response/error contracts'));
  it('receives a domain event and performs configured domain action', () => contract('outbox/event -> matcher -> execution -> owning service'));
  it('lists execution logs with cursor pagination', () => contract('execution log cursor and filters are deterministic'));
  it('retries a retryable failed execution with permission', () => contract('retry command creates safe retry and audit'));
  it('cancels a pending job but not irreversible completed side effect', () => contract('job cancellation state rules'));
  it('returns safe publish validation details', () => contract('publish failure identifies invalid field/condition/action without leaking internals'));
});
