import { contract } from '../harness';

describe('Attribution revenue basis contract', () => {
  it('keeps customer acquisition source distinct from Deal opportunity source', async () => {
    await contract('source distinction');
  });
  it('supports Won Deal revenue basis', async () => {
    await contract('won revenue attribution');
  });
  it('supports Paid/Collected revenue basis and excludes pending/failed payments', async () => {
    await contract('paid revenue attribution');
  });
  it('uses historical currency conversion for reporting value', async () => {
    await contract('attribution FX snapshot');
  });
  it('preserves separate Deals when customer records merge', async () => {
    await contract('merge attribution interaction');
  });
});
