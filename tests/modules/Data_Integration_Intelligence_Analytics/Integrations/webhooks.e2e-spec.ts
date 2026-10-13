import { contract } from '../harness';

describe('Webhook delivery/provider event E2E contract', () => {
  it('signs outgoing body and detects tampering', async () => {
    await contract('outgoing signature');
  });
  it('retries transient delivery failures and dead-letters after policy limit', async () => {
    await contract('webhook retry dead-letter');
  });
  it('manual replay creates a new delivery linked to original event and is audited', async () => {
    await contract('webhook replay');
  });
  it('rejects prohibited internal/loopback target URLs under egress policy', async () => {
    await contract('webhook SSRF protection');
  });
  it('rejects invalid incoming provider signature/replay before domain mutation', async () => {
    await contract('incoming verification');
  });
  it('processes duplicate provider event exactly once', async () => {
    await contract('provider event idempotency');
  });
  it('derives callback workspace from trusted connection mapping, not payload', async () => {
    await contract('provider callback tenant trust');
  });
});
