import { contract } from '../harness';

describe('Analytics projection contract', () => {
  it('replaying same domain event does not duplicate analytical fact', async () => {
    await contract('analytics event idempotency');
  });
  it('rebuild reconciles facts to authoritative source', async () => {
    await contract('analytics rebuild');
  });
  it('keeps transactional domain as source of truth', async () => {
    await contract('analytics non-mutation boundary');
  });
  it('preserves historical owner/stage/currency semantics where required', async () => {
    await contract('historical analytical snapshots');
  });
  it('exposes freshness/lag and rebuild state', async () => {
    await contract('analytics freshness');
  });
  it('processes ordinary analytics asynchronously from transaction commit', async () => {
    await contract('analytics async projection');
  });
});
