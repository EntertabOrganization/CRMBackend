import { contract } from '../harness';

describe('Public API E2E contract', () => {
  it('enforces /api/v1 workspace context from authenticated credential/session', async () => {
    await contract('trusted workspace context');
  });
  it('intersects application scope with user/service permissions', async () => {
    await contract('scope permission intersection');
  });
  it('revoked credential can no longer authenticate', async () => {
    await contract('credential revocation');
  });
  it('does not expose raw secret on get/list', async () => {
    await contract('secret one-time reveal');
  });
  it('uses deterministic cursor pagination', async () => {
    await contract('cursor pagination');
  });
  it('rejects unapproved filter/sort fields', async () => {
    await contract('query whitelist');
  });
  it('returns stable 429 behavior when rate limit is exceeded', async () => {
    await contract('distributed rate limiting');
  });
  it('prevents cross-tenant IDOR even with a valid UUID', async () => {
    await contract('API tenant isolation');
  });
});
