import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/10-dashboard-admin-and-search.md. These are fail-closed executable contracts, not mocks.
describe('Partner portal dashboard, dynamic query and reporting [repository contracts]', () => {
  it('AC01: Partner A cannot infer Partner B account totals.', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::AC01', 'Partner A cannot infer Partner B account totals.', 'INTEGRATION');
  });
  it('AC02: Unauthorized customer CRM record cannot be opened via dashboard.', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::AC02', 'Unauthorized customer CRM record cannot be opened via dashboard.', 'INTEGRATION');
  });
  it('AC03: Export after membership revoked fails.', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::AC03', 'Export after membership revoked fails.', 'INTEGRATION');
  });
  it('AC04: Dashboard invoice/commission sums reconcile to ledger.', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::AC04', 'Dashboard invoice/commission sums reconcile to ledger.', 'INTEGRATION');
  });
  it('AC05: Queries reject arbitrary SQL/ORM fields.', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::AC05', 'Queries reject arbitrary SQL/ORM fields.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/10-dashboard-admin-and-search::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
