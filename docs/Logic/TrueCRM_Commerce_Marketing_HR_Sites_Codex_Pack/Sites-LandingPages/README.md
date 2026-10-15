# Sites-LandingPages — module map

Core V1: managed site/domain, editor, page/blocks, draft vs live, publishing, localization, SEO, Forms/Commerce widgets; Advanced: script governance, A/B experiments, AI site generation, export/recovery and entitlement lifecycle.

**Core invariant:** Public request renders immutable activated release; editor draft changes must never leak to published views.

## Submodule specifications

- [`01-sites-hosting-and-domains.md`](01-sites-hosting-and-domains.md) — Operate responsive multi-page Sites and landing pages with managed subdomains and verified custom domains.
- [`02-pages-navigation-and-cms.md`](02-pages-navigation-and-cms.md) — Manage site pages, article/news entries, folders, navigation and redirects with stable unique routes.
- [`03-editor-blocks-and-themes.md`](03-editor-blocks-and-themes.md) — Implement schema-validated responsive block-based editing with versioned shared blocks.
- [`04-drafts-preview-and-publication.md`](04-drafts-preview-and-publication.md) — Ensure only authorized immutable revisions reach public visitors, with controlled multi-page publishing.
- [`05-localization-and-rtl.md`](05-localization-and-rtl.md) — Provide independent language publication, RTL rendering and safe fallback behavior.
- [`06-seo-search-and-performance.md`](06-seo-search-and-performance.md) — Publish indexable content responsibly with canonical metadata and fast cached public delivery.
- [`07-form-commerce-and-widget-blocks.md`](07-form-commerce-and-widget-blocks.md) — Connect published pages to existing Forms, Contact Center and Commerce services without duplicating their data.
- [`08-cookies-scripts-and-security.md`](08-cookies-scripts-and-security.md) — Apply region-specific consent and restrict custom code and third-party script execution.
- [`09-ab-experiments.md`](09-ab-experiments.md) — Run controlled page experiments with stable variant assignment and attributable conversion goals.
- [`10-ai-generation-and-templates.md`](10-ai-generation-and-templates.md) — Use shared AI gateway to generate draft layouts, copy and translations with review and usage controls.
- [`11-recovery-exports-and-entitlements.md`](11-recovery-exports-and-entitlements.md) — Preserve recoverability and explicit public behavior after downgrade or plan expiry.

## External owner boundaries

Own only records declared in the above specs. Other domains must be accessed through narrow typed service contracts, not direct table writes.

## Activation readiness / configuration

- Authenticated workspace membership/permissions and active entitlement must be resolved.
- Applicable locale/jurisdiction, tax, HR, consent and retention policies must be configured before enabling their corresponding operations.
- Any external provider needed for production operation must have a verified identity, separate secret and observable health state.
- Missing operational dependency must be surfaced as a blocker, never auto-created as a second source of truth.

## Tests

Every file above maps to `Testing/Sites-LandingPages/<same-slug>.spec.ts`; module E2E in `Testing/Sites-LandingPages/Sites-LandingPages.e2e-spec.ts`. See `Testing/README.md`.
