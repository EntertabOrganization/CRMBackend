import { verifyContractCase } from '../_harness/adapter';

describe('Visual blocks, components, templates, themes and assets (contract)', () => {
  it('Shared header draft changes no live pages until publish', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::AC01', "Shared header draft changes no live pages until publish");
  });
  it('Invalid props rejected', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::AC02', "Invalid props rejected");
  });
  it('uploaded unscanned asset never made public', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::AC03', "uploaded unscanned asset never made public");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/03-editor-blocks-and-themes::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
