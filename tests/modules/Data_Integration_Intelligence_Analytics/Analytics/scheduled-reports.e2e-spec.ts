import { contract } from '../harness';

describe('Scheduled report E2E contract', () => {
  it('executes using configured IANA timezone through shared scheduler', async () => {
    await contract('scheduled report timezone');
  });
  it('rechecks authorization at execution/delivery', async () => {
    await contract('scheduled report authorization');
  });
  it('does not send admin-scope artifact to recipient who lacks that data scope', async () => {
    await contract('recipient data isolation');
  });
  it('retry does not duplicate delivery uncontrollably', async () => {
    await contract('scheduled report delivery idempotency');
  });
  it('generates secure CSV/XLSX/PDF artifacts through shared export service', async () => {
    await contract('scheduled report export');
  });
});
