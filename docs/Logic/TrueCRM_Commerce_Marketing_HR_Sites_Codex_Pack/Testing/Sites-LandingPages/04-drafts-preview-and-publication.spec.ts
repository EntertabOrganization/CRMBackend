import { verifyContractCase } from '../_harness/adapter';

describe('Draft revisions, previews, approval, scheduling and rollback (contract)', () => {
  it('Draft edit does not change live page', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::AC01', "Draft edit does not change live page");
  });
  it('two concurrent publish commands activate one version', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::AC02', "two concurrent publish commands activate one version");
  });
  it('rollback restores correct navigation and shared blocks', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::AC03', "rollback restores correct navigation and shared blocks");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/04-drafts-preview-and-publication::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
