import { verifyContractCase } from '../_harness/adapter';

// Source spec: 31-Subscription-Billing/08-referrals-discounts-and-partner-billing.md. These are fail-closed executable contracts, not mocks.
describe('Partner pricing integration and payer/beneficiary separation [repository contracts]', () => {
  it('AC01: Changing Partner from A to B does not change invoice from A.', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::AC01', 'Changing Partner from A to B does not change invoice from A.', 'INTEGRATION');
  });
  it('AC02: Same customer Workspace never has two active Partner rate candidates.', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::AC02', 'Same customer Workspace never has two active Partner rate candidates.', 'INTEGRATION');
  });
  it('AC03: Client-supplied partnerId cannot force discount.', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::AC03', 'Client-supplied partnerId cannot force discount.', 'INTEGRATION');
  });
  it('AC04: Payer switch requires customer owner consent and audited approval.', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::AC04', 'Payer switch requires customer owner consent and audited approval.', 'INTEGRATION');
  });
  it('AC05: Discount and invoice totals reconcile exactly using NUMERIC rounding policy.', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::AC05', 'Discount and invoice totals reconcile exactly using NUMERIC rounding policy.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('31-Subscription-Billing/08-referrals-discounts-and-partner-billing::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
