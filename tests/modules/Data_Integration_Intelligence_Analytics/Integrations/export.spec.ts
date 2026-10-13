import { contract } from '../harness';

describe('Export contract', () => {
  it('exports only authorized rows and fields', async () => {
    await contract('export authorization');
  });
  it('supports CSV and XLSX regular entity exports', async () => {
    await contract('export formats');
  });
  it('runs large export asynchronously', async () => {
    await contract('async export');
  });
  it('stores artifact privately with default expiry policy', async () => {
    await contract('secure artifact');
  });
  it('rejects download after artifact expiry', async () => {
    await contract('artifact expiry');
  });
  it('neutralizes spreadsheet formula injection', async () => {
    await contract('spreadsheet export security');
  });
  it('does not allow arbitrary cross-domain SQL joins through regular export', async () => {
    await contract('export boundary');
  });
});
