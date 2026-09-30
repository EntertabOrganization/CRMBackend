import { contract } from '../harness';

describe('Semantic report builder E2E contract', () => {
  it('allows only approved semantic datasets/joins', async () => {
    await contract('semantic dataset boundary');
  });
  it('rejects arbitrary SQL from normal report user', async () => {
    await contract('no arbitrary SQL');
  });
  it('exposes eligible custom fields with correct type behavior', async () => {
    await contract('custom field analytics');
  });
  it('validates filters/operators against dataset metadata', async () => {
    await contract('report filter validation');
  });
  it('prevents many-to-many double count through grain/join rules', async () => {
    await contract('report grain safety');
  });
  it('drill-down reconciles to displayed metric and source permissions', async () => {
    await contract('report drill-down');
  });
  it('same shared report returns scope-appropriate results for different users', async () => {
    await contract('report permission filtering');
  });
});
