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


describe('Custom Fields - definitions, types and values', () => {
  it('creates a field with generated immutable code unique per workspace + entity type', async () => {
    contract('field code generation and uniqueness');
  });

  it('allows the same field code on another entity type and another workspace', async () => {
    contract('field code uniqueness boundary');
  });

  it('supports all locked initial field types including FILE and ADDRESS', async () => {
    contract('supported field type registry');
  });

  it('stores custom values using typed storage and preserves multi-value order', async () => {
    contract('typed value persistence and multiplicity');
  });

  it('applies static defaults only on create when the field is omitted', async () => {
    contract('create-only defaults');
  });

  it('treats 0 and false as present values while whitespace and empty arrays are empty', async () => {
    contract('empty value semantics');
  });

  it('rejects cross-workspace user, CRM and file references', async () => {
    contract('reference workspace isolation');
  });

  it('keeps historical inactive user references but excludes them from new selection by default', async () => {
    contract('inactive reference history');
  });

  it('deactivates a used list option without corrupting stored values', async () => {
    contract('list option deactivation');
  });

  it('rejects a new write selecting an inactive list option', async () => {
    contract('inactive option write rejection');
  });

  it('rejects direct type change when values exist and requires explicit migration', async () => {
    contract('type migration guard');
  });

  it('blocks hard delete when values or dependencies exist', async () => {
    contract('safe hard-delete rules');
  });

  it('returns a version conflict for stale configuration updates and reorders', async () => {
    contract('custom field optimistic concurrency');
  });
});
