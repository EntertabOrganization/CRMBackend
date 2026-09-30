import { contract } from '../harness';

describe('Attribution model contract', () => {
  it('calculates First Touch correctly', async () => {
    await contract('first-touch model');
  });
  it('calculates Last Touch correctly', async () => {
    await contract('last-touch model');
  });
  it('calculates Linear allocation that sums to 100 percent', async () => {
    await contract('linear model');
  });
  it('calculates versioned Position-Based allocation that reconciles', async () => {
    await contract('position-based model');
  });
  it('calculates reproducible Time-Decay allocation from versioned parameters', async () => {
    await contract('time-decay model');
  });
  it('excludes touches outside attribution window or after outcome', async () => {
    await contract('attribution qualification');
  });
  it('stores model version and window on result', async () => {
    await contract('attribution result versioning');
  });
  it('recalculation is idempotent', async () => {
    await contract('attribution recalculation idempotency');
  });
});
