const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Automation security and tenant isolation', () => {
  it('rejects Rule target from another workspace', () => contract('cross-workspace target ID cannot execute'));
  it('does not allow edit permission to imply publish permission', () => contract('separate publish authorization'));
  it('does not allow manual execution against inaccessible record', () => contract('manual run requires target access/execution policy'));
  it('validates custom trigger payload and installation workspace', () => contract('custom trigger cannot choose tenant or bypass schema'));
  it('never exposes extension credentials in API or logs', () => contract('secret reference/redaction policy'));
  it('prevents HTTP action from unsafe SSRF target', () => contract('egress policy blocks internal/private metadata target'));
  it('keeps service execution scoped instead of platform-superuser', () => contract('automation service policy cannot perform unregistered privileged action'));
});

export {};
