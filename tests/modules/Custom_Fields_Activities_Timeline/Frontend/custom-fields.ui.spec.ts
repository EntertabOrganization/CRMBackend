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


describe('Frontend - Custom & Required Fields contract', () => {
  it('renders create/edit/detail fields from authorized server schema', async () => {
    contract('metadata-driven CRM field rendering');
  });

  it('does not render hidden fields and renders read-only fields as non-editable', async () => {
    contract('field permission UI');
  });

  it('shows all server field validation errors without losing entered form data', async () => {
    contract('field validation UI');
  });

  it('supports list option add/edit/reorder/deactivate without destructive used-option delete', async () => {
    contract('list option settings UI');
  });

  it('shows dependency impact before field deactivation', async () => {
    contract('field dependency UI');
  });

  it('uses explicit migration preview when changing a field type with data', async () => {
    contract('field type migration UI');
  });

  it('builds nested conditional requirement rules with only type-supported operators', async () => {
    contract('required condition builder UI');
  });

  it('handles FIELD_SCHEMA_CHANGED without silently dropping unsaved user input', async () => {
    contract('schema realtime UI');
  });
});

export {};
