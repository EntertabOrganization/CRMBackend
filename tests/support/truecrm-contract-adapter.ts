import { genericCases, Probe, type Evidence, type Generic } from './truecrm/probe';
import { seeders, type Seeded } from './truecrm/fixtures';
import { observe, send, type Fixture, type Req, type Res } from './truecrm/world';
import { commerceCases, commerceGeneric } from './truecrm/cases-commerce';
import { marketingCases, marketingGeneric } from './truecrm/cases-marketing';
import { hrCases, hrGeneric } from './truecrm/cases-hr';
import { sitesCases, sitesGeneric } from './truecrm/cases-sites';

/**
 * TrueCRM repository binding for docs pack `TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack` (suites live in
 * tests/modules/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack). Seeds an owned, migrated PostgreSQL database
 * (`truecrm_suite_contract_test`), dispatches real requests through the module route handlers and reads persisted
 * state. Unknown case IDs fail closed ("CONTRACT TEST NOT WIRED").
 */
const MODULES: Record<string, { generic: Generic; cases: Record<string, (p: Probe) => Promise<void>> }> = {
  'OnlineStore-Commerce': { generic: commerceGeneric, cases: commerceCases },
  'Marketing-Campaigns': { generic: marketingGeneric, cases: marketingCases },
  'HR-TimeTracking': { generic: hrGeneric, cases: hrCases },
  'Sites-LandingPages': { generic: sitesGeneric, cases: sitesCases },
};

export function createHarness() {
  const worlds = new Map<string, Seeded>();
  const world = (fixture: Fixture) => {
    const seeded = worlds.get(fixture.workspaceId);
    if (!seeded) throw new Error('Fixture was not seeded by this harness: ' + fixture.workspaceId);
    return seeded.world;
  };
  return {
    async seed(name: string): Promise<Fixture> {
      const seeder = seeders[name];
      if (!seeder) throw new Error('CONTRACT TEST NOT WIRED: unknown fixture scenario ' + name);
      const seeded = await seeder();
      worlds.set(seeded.fixture.workspaceId, seeded);
      return seeded.fixture;
    },
    async request(fixture: Fixture, input: Req): Promise<Res> { return send(world(fixture), fixture, input); },
    async observe(fixture: Fixture, collection: string, where?: Record<string, unknown>) { return observe(world(fixture), fixture, collection, where); },
    async runContractCase(id: string, requirement: string): Promise<Evidence> {
      const [module, rest] = id.split('/'), [file, caseId] = (rest ?? '').split('::');
      const binding = MODULES[module];
      const run = binding && (/^S0[1-4]$/.test(caseId) ? (p: Probe) => genericCases[caseId](p, binding.generic) : binding.cases[`${file}::${caseId}`]);
      if (!run) throw new Error(`CONTRACT TEST NOT WIRED: ${id} (${requirement})`);
      const seeded = await seeders[binding.generic.scenario]();
      worlds.set(seeded.fixture.workspaceId, seeded);
      const probe = new Probe(seeded);
      try { await run(probe); }
      catch (error) { probe.failures.push(`${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); }
      return probe.evidence();
    },
  };
}
export const harness = createHarness();
