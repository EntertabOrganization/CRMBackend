import { contract } from '../harness';

describe('Visitor identity contract', () => {
  it('creates random workspace-scoped first-party visitor/session identifiers', async () => {
    await contract('visitor identifier security');
  });
  it('respects privacy/consent mode before persisting anonymous analytics', async () => {
    await contract('tracking privacy policy');
  });
  it('uses deterministic identity linking rather than probabilistic fingerprinting', async () => {
    await contract('identity stitching policy');
  });
  it('never links visitor to CRM entity in another workspace', async () => {
    await contract('visitor identity tenant isolation');
  });
  it('preserves previous touch history when visitor becomes known', async () => {
    await contract('anonymous-to-known history');
  });
});
