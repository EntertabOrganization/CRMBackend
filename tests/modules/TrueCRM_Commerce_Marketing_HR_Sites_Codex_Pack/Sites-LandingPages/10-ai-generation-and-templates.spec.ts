import { verifyContractCase } from '../_harness/adapter';

describe('AI page drafts and content generation (contract)', () => {
  it('AI output malicious script rejected', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::AC01', "AI output malicious script rejected");
  });
  it('no publication on generation', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::AC02', "no publication on generation");
  });
  it('cost reported by workspace/user/scenario and failure not billed twice locally', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::AC03', "cost reported by workspace/user/scenario and failure not billed twice locally");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/10-ai-generation-and-templates::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
