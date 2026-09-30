import { contract } from '../harness';

describe('Batch API contract', () => {
  it('accepts at most 50 sub-operations', async () => {
    await contract('batch maximum');
  });
  it('authorizes and validates every sub-operation independently', async () => {
    await contract('batch authorization');
  });
  it('returns per-operation outcome rather than implying one global transaction', async () => {
    await contract('batch independent results');
  });
  it('accounts batch operations to rate limits', async () => {
    await contract('batch rate accounting');
  });
});
