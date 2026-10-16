import { verifyContractCase } from '../_harness/adapter';

// Source spec: 31-Subscription-Billing/05-entitlement-usage-reservations-and-overages.md. These are fail-closed executable contracts, not mocks.
describe('Quotas, usage reservations and overage controls [repository contracts]', () => {
  it('AC01: Two concurrent AI runs cannot overspend cap.', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::AC01', 'Two concurrent AI runs cannot overspend cap.', 'INTEGRATION');
  });
  it('AC02: Failed AI run releases unconsumed reservation.', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::AC02', 'Failed AI run releases unconsumed reservation.', 'INTEGRATION');
  });
  it('AC03: Duplicate settlement creates exactly one usage event.', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::AC03', 'Duplicate settlement creates exactly one usage event.', 'INTEGRATION');
  });
  it('AC04: No hard-coded plan name in consumer.', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::AC04', 'No hard-coded plan name in consumer.', 'INTEGRATION');
  });
  it('AC05: Overage not charged without accepted active price and cap.', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::AC05', 'Overage not charged without accepted active price and cap.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('31-Subscription-Billing/05-entitlement-usage-reservations-and-overages::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
