export {};

/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('Export contract', () => {
  it('exports only authorized rows and fields', async () => {
    contract('export authorization');
  });
  it('supports CSV and XLSX regular entity exports', async () => {
    contract('export formats');
  });
  it('runs large export asynchronously', async () => {
    contract('async export');
  });
  it('stores artifact privately with default expiry policy', async () => {
    contract('secure artifact');
  });
  it('rejects download after artifact expiry', async () => {
    contract('artifact expiry');
  });
  it('neutralizes spreadsheet formula injection', async () => {
    contract('spreadsheet export security');
  });
  it('does not allow arbitrary cross-domain SQL joins through regular export', async () => {
    contract('export boundary');
  });
});
