import { verifyContractCase } from '../_harness/adapter';

describe('32-Partner-Program [full integration E2E]', () => {
  it('E01: Public applicant with reused User approved atomically into Partner, Role, Membership and discounts', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E01', 'Public applicant with reused User approved atomically into Partner, Role, Membership and discounts', 'E2E');
  });
  it('E02: Partner user never has implicit WorkspaceMembership or Workspace Owner rights', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E02', 'Partner user never has implicit WorkspaceMembership or Workspace Owner rights', 'E2E');
  });
  it('E03: Two Partners racing customer relation: only one ACTIVE by database unique constraint', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E03', 'Two Partners racing customer relation: only one ACTIVE by database unique constraint', 'E2E');
  });
  it('E04: Delegated Workspace read-only grant has finite expiry, immediate customer-initiated revocation', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E04', 'Delegated Workspace read-only grant has finite expiry, immediate customer-initiated revocation', 'E2E');
  });
  it('E05: Billing discount resolves deterministic product/category/default basis points and historical snapshot', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E05', 'Billing discount resolves deterministic product/category/default basis points and historical snapshot', 'E2E');
  });
  it('E06: Settled referred revenue creates one commission; refund appends reversal and no duplicate accrual', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E06', 'Settled referred revenue creates one commission; refund appends reversal and no duplicate accrual', 'E2E');
  });
  it('E07: Finance-approved payout batch reconciles evidence; failure preserves outstanding liability', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E07', 'Finance-approved payout batch reconciles evidence; failure preserves outstanding liability', 'E2E');
  });
  it('E08: Partner suspension removes new commerce/delegation while customer Workspace and bills persist', async () => {
    await verifyContractCase('32-Partner-Program/JOURNEY::E08', 'Partner suspension removes new commerce/delegation while customer Workspace and bills persist', 'E2E');
  });
});
