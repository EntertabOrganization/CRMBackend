import { contract } from '../harness';

describe('Traffic source/tracking contract', () => {
  it('resolves source using deterministic evidence precedence', async () => {
    await contract('source resolution precedence');
  });
  it('stores explainable rule/version evidence for each touch', async () => {
    await contract('source explainability');
  });
  it('supports system and custom online/offline sources', async () => {
    await contract('source registry');
  });
  it('records managed tracking-link click and prevents open redirect', async () => {
    await contract('tracking link');
  });
  it('maps static tracking number to configured source', async () => {
    await contract('static call tracking');
  });
  it('maps supported inbound email alias to source', async () => {
    await contract('email source tracking');
  });
  it('manual override remains separate/auditable and does not erase original evidence', async () => {
    await contract('source override history');
  });
});
