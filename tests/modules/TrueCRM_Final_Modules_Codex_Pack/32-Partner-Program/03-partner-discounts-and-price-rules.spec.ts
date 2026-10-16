import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/03-partner-discounts-and-price-rules.md. These are fail-closed executable contracts, not mocks.
describe('Partner default discounts, overrides and effective pricing [repository contracts]', () => {
  it('AC01: 10% stores as 1000 bps and resolves accurately.', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::AC01', '10% stores as 1000 bps and resolves accurately.', 'INTEGRATION');
  });
  it('AC02: Old invoice remains same after rate change.', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::AC02', 'Old invoice remains same after rate change.', 'INTEGRATION');
  });
  it('AC03: Partner B discount never applies to Partner A customer.', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::AC03', 'Partner B discount never applies to Partner A customer.', 'INTEGRATION');
  });
  it('AC04: Expired override falls back to valid rule.', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::AC04', 'Expired override falls back to valid rule.', 'INTEGRATION');
  });
  it('AC05: Same quote repeatedly resolves same immutable price snapshot.', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::AC05', 'Same quote repeatedly resolves same immutable price snapshot.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/03-partner-discounts-and-price-rules::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
