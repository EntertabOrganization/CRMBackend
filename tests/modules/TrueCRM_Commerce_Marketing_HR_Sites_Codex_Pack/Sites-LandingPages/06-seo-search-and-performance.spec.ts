import { verifyContractCase } from '../_harness/adapter';

describe('SEO settings, sitemaps, search and public performance (contract)', () => {
  it('Draft page excluded from sitemap', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::AC01', "Draft page excluded from sitemap");
  });
  it('canonical URL mapped to verified hostname', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::AC02', "canonical URL mapped to verified hostname");
  });
  it('publish immediately exposes new cache version', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::AC03', "publish immediately exposes new cache version");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Sites-LandingPages/06-seo-search-and-performance::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
