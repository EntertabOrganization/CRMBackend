const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Automation frontend contracts', () => {
  it('renders Rule list with status/revision/last-run state', () => contract('Automation list UI'));
  it('builds nested condition groups using backend type metadata', () => contract('condition editor operators are type-aware'));
  it('configures and reorders registered Actions', () => contract('Action schema-driven editor and deterministic reorder'));
  it('shows publish validation at relevant sections', () => contract('invalid field/action/trigger configuration UX'));
  it('runs dry-run and clearly shows no side effects', () => contract('dry-run results UI'));
  it('shows execution details, action attempts and safe retry controls', () => contract('execution log UI'));
  it('handles stale Rule version conflict without overwriting newer admin edits', () => contract('optimistic concurrency UX'));
});
