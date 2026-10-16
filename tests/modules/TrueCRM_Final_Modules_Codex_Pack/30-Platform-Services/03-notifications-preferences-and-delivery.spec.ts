import { verifyContractCase } from '../_harness/adapter';

// Source spec: 30-Platform-Services/03-notifications-preferences-and-delivery.md. These are fail-closed executable contracts, not mocks.
describe('Notifications, preferences, mandatory notices [repository contracts]', () => {
  it('AC01: Critical security notice delivered even if optional preferences off.', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::AC01', 'Critical security notice delivered even if optional preferences off.', 'INTEGRATION');
  });
  it('AC02: Missing live socket recovered on inbox refresh.', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::AC02', 'Missing live socket recovered on inbox refresh.', 'INTEGRATION');
  });
  it('AC03: Revoked record does not reveal private title through notification body.', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::AC03', 'Revoked record does not reveal private title through notification body.', 'INTEGRATION');
  });
  it('AC04: Duplicate provider callback does not change delivery twice.', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::AC04', 'Duplicate provider callback does not change delivery twice.', 'INTEGRATION');
  });
  it('AC05: Two workspaces with same user keep independent notifications.', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::AC05', 'Two workspaces with same user keep independent notifications.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('30-Platform-Services/03-notifications-preferences-and-delivery::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
