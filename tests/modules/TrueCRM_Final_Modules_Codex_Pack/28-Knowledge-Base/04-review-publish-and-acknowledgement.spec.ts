import { verifyContractCase } from '../_harness/adapter';

// Source spec: 28-Knowledge-Base/04-review-publish-and-acknowledgement.md. These are fail-closed executable contracts, not mocks.
describe('Publishing, reviews and policy acknowledgements [repository contracts]', () => {
  it('AC01: Reviewer approves version v3; v4 edit does not inherit that approval.', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::AC01', 'Reviewer approves version v3; v4 edit does not inherit that approval.', 'INTEGRATION');
  });
  it('AC02: Published revision remains readable while draft changes.', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::AC02', 'Published revision remains readable while draft changes.', 'INTEGRATION');
  });
  it('AC03: Employee cannot acknowledge another person\'s required policy.', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::AC03', 'Employee cannot acknowledge another person\'s required policy.', 'INTEGRATION');
  });
  it('AC04: Repeat acknowledgement is idempotent; old version remains recorded.', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::AC04', 'Repeat acknowledgement is idempotent; old version remains recorded.', 'INTEGRATION');
  });
  it('AC05: Overdue review notifies owner but does not erase article.', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::AC05', 'Overdue review notifies owner but does not erase article.', 'INTEGRATION');
  });
  it('S01: cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::S01', 'cross-tenant/cross-Partner UUID cannot disclose hidden record or counts', 'INTEGRATION');
  });
  it('S02: unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::S02', 'unauthorized command causes zero domain mutations, zero business audit/outbox, zero provider effects', 'INTEGRATION');
  });
  it('S03: repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::S03', 'repeated identical command/provider receipt is exactly-once-effective; changed same-key payload conflicts', 'INTEGRATION');
  });
  it('S04: critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', async () => {
    await verifyContractCase('28-Knowledge-Base/04-review-publish-and-acknowledgement::S04', 'critical authorized mutation commits domain state, redacted audit and outbox atomically; failed transaction leaves none', 'INTEGRATION');
  });
});
