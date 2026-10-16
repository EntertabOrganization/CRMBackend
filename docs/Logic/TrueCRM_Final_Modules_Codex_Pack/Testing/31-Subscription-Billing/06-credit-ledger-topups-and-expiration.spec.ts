import { verifyContractCase } from '../_harness/adapter';

// Source spec: 31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md. These are fail-closed executable contracts, not mocks.
describe('AI credit ledger, grant types, top-ups and expiration [repository contracts]', () => {
  it('AC01: Plan credits spent before purchased eligible credits.', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::AC01', 'Plan credits spent before purchased eligible credits.', 'INTEGRATION');
  });
  it('AC02: Partial settle releases remaining reserved amount.', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::AC02', 'Partial settle releases remaining reserved amount.', 'INTEGRATION');
  });
  it('AC03: Credit reversal preserves original entry and net balance.', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::AC03', 'Credit reversal preserves original entry and net balance.', 'INTEGRATION');
  });
  it('AC04: Duplicate provider event never grants twice.', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::AC04', 'Duplicate provider event never grants twice.', 'INTEGRATION');
  });
  it('AC05: Concurrent requests cannot drive available below zero.', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::AC05', 'Concurrent requests cannot drive available below zero.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('31-Subscription-Billing/06-credit-ledger-topups-and-expiration::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
