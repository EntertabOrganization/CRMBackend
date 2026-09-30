import { contract } from '../harness';

describe('KPI/schedule/BI unit contract', () => {
  it('stores KPI target as first-class reusable object', async () => {
    await contract('KPI target model');
  });
  it('validates target unit/currency/subject compatibility', async () => {
    await contract('KPI validation');
  });
  it('uses Metric Registry semantics for achievement calculation', async () => {
    await contract('KPI metric consistency');
  });
  it('stores BI credential metadata without raw reusable secret', async () => {
    await contract('BI credential security');
  });
  it('enforces allowed dataset list on BI access', async () => {
    await contract('BI dataset scope');
  });
});
