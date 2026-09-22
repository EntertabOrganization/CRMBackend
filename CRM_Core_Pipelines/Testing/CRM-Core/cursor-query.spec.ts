/**
 * TrueCRM executable contract test.
 *
 * This file MUST be wired to the real repository implementation by the coding agent.
 * Do not skip/delete/weaken required scenarios. Replace `contract()` with real setup/assertions.
 */

const contract = (scenario: string): never => {
  throw new Error(
    `CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario to the repository implementation before declaring the module finished.`,
  );
};

describe('CRM cursor query contract', () => {
  it('returns limit nextCursor and hasMore metadata', async () => {
    contract('cursor response metadata');
  });

  it('uses a stable ID tie-breaker for sorted pagination', async () => {
    contract('cursor stable ordering');
  });

  it('whitelists filterable sortable and searchable fields', async () => {
    contract('crm query whitelist');
  });

  it('does not expose arbitrary Prisma fields through filters', async () => {
    contract('crm query input hardening');
  });

});
