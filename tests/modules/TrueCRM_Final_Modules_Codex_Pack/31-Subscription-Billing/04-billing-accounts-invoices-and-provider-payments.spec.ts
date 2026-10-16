import { verifyContractCase } from '../_harness/adapter';

// Source spec: 31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments.md. These are fail-closed executable contracts, not mocks.
describe('Billing accounts, invoices, payments and provider reconciliation [repository contracts]', () => {
  it('AC01: Duplicate Stripe event creates one payment.', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::AC01', 'Duplicate Stripe event creates one payment.', 'INTEGRATION');
  });
  it('AC02: Unverified XPay callback cannot mark invoice paid.', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::AC02', 'Unverified XPay callback cannot mark invoice paid.', 'INTEGRATION');
  });
  it('AC03: Partial payment leaves balance correct.', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::AC03', 'Partial payment leaves balance correct.', 'INTEGRATION');
  });
  it('AC04: Partner paid invoice belongs to Partner payer without granting tenant ownership.', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::AC04', 'Partner paid invoice belongs to Partner payer without granting tenant ownership.', 'INTEGRATION');
  });
  it('AC05: Partial refund leaves immutable successful payment intact.', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::AC05', 'Partial refund leaves immutable successful payment intact.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
