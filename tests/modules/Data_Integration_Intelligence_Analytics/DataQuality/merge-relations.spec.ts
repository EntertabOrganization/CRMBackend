import { contract } from '../harness';

describe('Merge relation rebind contract', () => {
  it('rebinds Deal customer/contact relations without merging Deals', async () => {
    await contract('deal rebind');
  });
  it('rebinds supported activities/forms/conversation links', async () => {
    await contract('mutable relation rebind');
  });
  it('does not rewrite issued invoice, payment or generated-document snapshots', async () => {
    await contract('immutable commercial history');
  });
  it('does not automatically collapse distinct requisites', async () => {
    await contract('requisite preservation');
  });
  it('flattens redirect chains without cycles', async () => {
    await contract('merged ID redirect resolution');
  });
});
