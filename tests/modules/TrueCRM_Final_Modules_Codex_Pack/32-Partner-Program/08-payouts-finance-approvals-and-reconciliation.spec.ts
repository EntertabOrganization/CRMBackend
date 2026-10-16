import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/08-payouts-finance-approvals-and-reconciliation.md. These are fail-closed executable contracts, not mocks.
describe('Partner payouts, finance approval and reconciliation [repository contracts]', () => {
  it('AC01: Two payout requests racing cannot claim same commission twice.', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::AC01', 'Two payout requests racing cannot claim same commission twice.', 'INTEGRATION');
  });
  it('AC02: Failed payout preserves liability.', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::AC02', 'Failed payout preserves liability.', 'INTEGRATION');
  });
  it('AC03: Unapproved manual mark-paid rejected.', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::AC03', 'Unapproved manual mark-paid rejected.', 'INTEGRATION');
  });
  it('AC04: Partially reversed commission cannot pay original gross amount.', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::AC04', 'Partially reversed commission cannot pay original gross amount.', 'INTEGRATION');
  });
  it('AC05: Partner sees own payout only.', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::AC05', 'Partner sees own payout only.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/08-payouts-finance-approvals-and-reconciliation::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
