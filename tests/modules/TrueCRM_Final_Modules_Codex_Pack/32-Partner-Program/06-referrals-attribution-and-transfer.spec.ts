import { verifyContractCase } from '../_harness/adapter';

// Source spec: 32-Partner-Program/06-referrals-attribution-and-transfer.md. These are fail-closed executable contracts, not mocks.
describe('Partner referral codes, attribution and reassignment [repository contracts]', () => {
  it('AC01: Referral click does not grant Workspace access.', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::AC01', 'Referral click does not grant Workspace access.', 'INTEGRATION');
  });
  it('AC02: Transfer cannot result in two active Partners even under concurrency.', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::AC02', 'Transfer cannot result in two active Partners even under concurrency.', 'INTEGRATION');
  });
  it('AC03: Old invoices keep old Partner.', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::AC03', 'Old invoices keep old Partner.', 'INTEGRATION');
  });
  it('AC04: Expired code stops new attribution.', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::AC04', 'Expired code stops new attribution.', 'INTEGRATION');
  });
  it('AC05: Partner cannot approve transfer to self without customer consent.', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::AC05', 'Partner cannot approve transfer to self without customer consent.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('32-Partner-Program/06-referrals-attribution-and-transfer::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
