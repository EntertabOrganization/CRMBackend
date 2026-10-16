import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/07-commissions-and-accrual-ledger.md. These are fail-closed executable contracts, not mocks.
describe('Commission eligibility, accrual and reversals [repository contracts]', () => {
  it('AC01: Unpaid invoice produces no eligible commission.', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::AC01', 'Unpaid invoice produces no eligible commission.', 'INTEGRATION');
  });
  it('AC02: Duplicate provider payment produces one commission.', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::AC02', 'Duplicate provider payment produces one commission.', 'INTEGRATION');
  });
  it('AC03: Partial refund creates proportional policy-governed reversal.', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::AC03', 'Partial refund creates proportional policy-governed reversal.', 'INTEGRATION');
  });
  it('AC04: Discount is not mistaken for commission.', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::AC04', 'Discount is not mistaken for commission.', 'INTEGRATION');
  });
  it('AC05: Partner A cannot inspect Partner B amounts.', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::AC05', 'Partner A cannot inspect Partner B amounts.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/07-commissions-and-accrual-ledger::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
