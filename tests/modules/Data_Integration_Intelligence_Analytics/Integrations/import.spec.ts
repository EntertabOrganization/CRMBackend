import { contract } from '../harness';

describe('Import service contract', () => {
  it('supports CSV and XLSX inputs', async () => {
    await contract('supported import formats');
  });
  it('supports CREATE, UPDATE and UPSERT modes', async () => {
    await contract('import modes');
  });
  it('rejects invalid field/type mapping before start', async () => {
    await contract('mapping validation');
  });
  it('prefers stable internal/external identifiers over fuzzy names', async () => {
    await contract('stable matching keys');
  });
  it('delegates duplicate behavior to configured Data Quality policy', async () => {
    await contract('duplicate engine reuse');
  });
  it('never links a relationship to another workspace', async () => {
    await contract('import relationship tenant isolation');
  });
  it('records one deterministic outcome per processed row', async () => {
    await contract('row outcome');
  });
  it('retries/resumes without duplicating committed rows', async () => {
    await contract('import checkpoint idempotency');
  });
});
