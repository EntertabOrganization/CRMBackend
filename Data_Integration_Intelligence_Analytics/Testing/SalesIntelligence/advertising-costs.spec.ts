import { contract } from '../harness';

describe('Marketing cost/provider contract', () => {
  it('uses provider adapters for Google Ads and Meta Ads priorities', async () => {
    await contract('ad provider adapter boundary');
  });
  it('deduplicates retried provider cost records', async () => {
    await contract('provider cost idempotency');
  });
  it('supports PROVIDER, MANUAL and IMPORT origins', async () => {
    await contract('marketing cost origins');
  });
  it('keeps same external campaign IDs isolated by connection/provider', async () => {
    await contract('campaign external ID namespace');
  });
  it('preserves original currency and historical FX reference', async () => {
    await contract('cost currency history');
  });
  it('does not overwrite TrueCRM attribution with provider-reported conversions', async () => {
    await contract('provider metric separation');
  });
  it('shows unresolved source/campaign mapping in cost import preview', async () => {
    await contract('cost import mapping');
  });
});
