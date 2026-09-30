import { contract } from '../harness';

describe('Metric Registry contract', () => {
  it('published metric version is immutable', async () => {
    await contract('metric immutability');
  });
  it('new formula semantics require a new version', async () => {
    await contract('metric versioning');
  });
  it('documents event-date and currency basis', async () => {
    await contract('metric governance');
  });
  it('equivalent filters using same metric version reconcile across consumers', async () => {
    await contract('metric consistency');
  });
  it('won and paid metrics use different correct business dates', async () => {
    await contract('metric date semantics');
  });
  it('handles zero/null denominator according to declared policy', async () => {
    await contract('metric null/zero policy');
  });
});
