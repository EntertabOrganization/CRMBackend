/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Fields, Schema Drafts and Publication — unit/integration contract', () => {
  it('field metadata validates every supported typed value and multi-value option membership', async () => { contract('field metadata validates every supported typed value and multi-value option membership'); });
  it('system field name rejected and duplicate codes rejected', async () => { contract('system field name rejected and duplicate codes rejected'); });
  it('schema draft edited without mutating published schema', async () => { contract('schema draft edited without mutating published schema'); });
  it('schema publish increments version and invalidates cache/search projections', async () => { contract('schema publish increments version and invalidates cache/search projections'); });
  it('field type migration previews incompatible existing records', async () => { contract('field type migration previews incompatible existing records'); });
  it('publishing migration while conversion errors exist is blocked', async () => { contract('publishing migration while conversion errors exist is blocked'); });
  it('adding unique constraint to duplicate live data is rejected', async () => { contract('adding unique constraint to duplicate live data is rejected'); });
  it('field deactivation preserves prior item values', async () => { contract('field deactivation preserves prior item values'); });
  it('unauthorized schema write and cross-workspace IDs rejected', async () => { contract('unauthorized schema write and cross-workspace IDs rejected'); });
});
