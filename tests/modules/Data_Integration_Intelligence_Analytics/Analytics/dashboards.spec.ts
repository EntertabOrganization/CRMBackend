import { contract } from '../harness';

describe('Dashboard contract', () => {
  it('editing built-in creates/customizes a copy without corrupting system template', async () => {
    await contract('built-in dashboard immutability');
  });
  it('supports global compatible filters plus visible widget-local filters', async () => {
    await contract('dashboard filter layering');
  });
  it('shows freshness/stale state', async () => {
    await contract('dashboard freshness');
  });
  it('does not leak broader cached result to narrower-permission user', async () => {
    await contract('dashboard cache authorization');
  });
  it('supports private/selected/department/team/workspace visibility without widening source access', async () => {
    await contract('dashboard sharing');
  });
});
