const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Automation Rule definitions and revisions', () => {
  it('creates a Draft rule for a registered target', () => contract('create Draft rule with workspace-scoped registered target'));
  it('rejects unknown target/trigger/action types', () => contract('publish validation rejects unavailable registry types'));
  it('publishes an immutable revision', () => contract('published revision cannot be mutated in place'));
  it('creates a new Draft after published configuration is edited', () => contract('published edit creates new revision'));
  it('detects optimistic concurrency conflicts', () => contract('stale Draft update returns version conflict'));
  it('orders matching rules deterministically', () => contract('priority plus stable tie-breaker controls match ordering'));
  it('evaluates nested AND/OR typed conditions', () => contract('condition tree evaluates type-aware operators'));
  it('rejects unsafe or type-invalid condition expressions', () => contract('no arbitrary code and invalid operator/type rejected'));
  it('dry-runs without side effects', () => contract('dry run returns evaluation/action preview and executes nothing'));
  it('manual execution still evaluates normal conditions', () => contract('manual run does not bypass Rule conditions'));
});
