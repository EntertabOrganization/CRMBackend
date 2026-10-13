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


describe('Custom Fields E2E contract', () => {
  it('creates a Deal custom field then creates/updates a Deal with customFields atomically', async () => {
    contract('custom field + owning record E2E');
  });

  it('returns all safe field-level validation errors in one response', async () => {
    contract('multi-field validation response');
  });

  it('omits hidden fields from normal schema and record API responses', async () => {
    contract('hidden field API redaction');
  });

  it('rejects direct API writes to a visible read-only field', async () => {
    contract('read-only field server enforcement');
  });

  it('rejects foreign-workspace field IDs/options/references/stages even when UUIDs are valid', async () => {
    contract('custom fields tenant isolation E2E');
  });

  it('atomically reorders fields and invalidates schema version/cache', async () => {
    contract('field reorder/schema version');
  });

  it('reports dependencies before deactivation and does not silently break active rules', async () => {
    contract('dependency-aware deactivation');
  });
});

export {};
