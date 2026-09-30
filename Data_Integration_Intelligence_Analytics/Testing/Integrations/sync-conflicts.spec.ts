import { contract } from '../harness';

describe('Synchronization conflict contract', () => {
  it('supports TrueCRM-wins, external-wins, last-modified, field-ownership and manual policies', async () => {
    await contract('conflict policies');
  });
  it('keeps unresolved manual conflict visible instead of silently overwriting', async () => {
    await contract('manual conflict visibility');
  });
  it('rechecks versions before applying manual resolution', async () => {
    await contract('conflict stale-state check');
  });
  it('audits conflict resolution', async () => {
    await contract('conflict resolution audit');
  });
});
