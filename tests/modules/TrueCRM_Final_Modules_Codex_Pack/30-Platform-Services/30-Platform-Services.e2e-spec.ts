import { verifyContractCase } from '../_harness/adapter';

describe('30-Platform-Services [full integration E2E]', () => {
  it('E01: Domain transaction writes authoritative state, audit and outbox atomically', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E01', 'Domain transaction writes authoritative state, audit and outbox atomically', 'E2E');
  });
  it('E02: Worker crash redelivery causes one business effect and visible job attempt history', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E02', 'Worker crash redelivery causes one business effect and visible job attempt history', 'E2E');
  });
  it('E03: Missed websocket notification recovered from durable inbox; unrelated Workspace hidden', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E03', 'Missed websocket notification recovered from durable inbox; unrelated Workspace hidden', 'E2E');
  });
  it('E04: Expired or revoked ACL blocks stale indexed search hits and private snippets', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E04', 'Expired or revoked ACL blocks stale indexed search hits and private snippets', 'E2E');
  });
  it('E05: Platform Admin cannot read customer Knowledge without approved scoped support access', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E05', 'Platform Admin cannot read customer Knowledge without approved scoped support access', 'E2E');
  });
  it('E06: Legal hold blocks module purge, portability export contains authorized subject data only', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E06', 'Legal hold blocks module purge, portability export contains authorized subject data only', 'E2E');
  });
  it('E07: Redis flush does not lose credit idempotency keys or authoritative state', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E07', 'Redis flush does not lose credit idempotency keys or authoritative state', 'E2E');
  });
  it('E08: Isolated backup restore test and operational alert records completed with redacted telemetry', async () => {
    await verifyContractCase('30-Platform-Services/JOURNEY::E08', 'Isolated backup restore test and operational alert records completed with redacted telemetry', 'E2E');
  });
});
