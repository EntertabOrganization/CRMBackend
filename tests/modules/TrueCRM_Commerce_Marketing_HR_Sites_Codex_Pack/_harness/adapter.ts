/**
 * REPOSITORY BINDING REQUIRED. No network or database access is preconfigured in this ZIP.
 * The coding agent must wire this interface to a *real* NestJS app, an isolated PostgreSQL
 * test database and deterministic external-provider fakes, NOT to fabricated all-green answers.
 */
import { resolve } from 'node:path';

export type Actor = 'owner' | 'admin' | 'employee' | 'manager' | 'hr' | 'publisher' | 'marketer' | 'customer' | 'guest' | 'outsider';
export type Verb = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Fixture { workspaceId: string; otherWorkspaceId: string; ids: Record<string,string>; tokens: Partial<Record<Actor,string>>; publicHost?:string; metadata?:Record<string,unknown> }
export interface Request { actor: Actor; method: Verb; path: string; body?:unknown; headers?:Record<string,string> }
export interface ApiResponse { status:number; body:{ success?:boolean; data?:any; error?:{code?:string; details?:unknown}; requestId?:string; meta?:unknown } }
export type ObservationName = 'orders'|'inventory_reservations'|'payment_allocations'|'refunds'|'marketing_deliveries'|'marketing_events'|'suppression_entries'|'hr_work_events'|'hr_timesheets'|'hr_leave_ledger'|'site_releases'|'site_page_revisions'|'audit_events'|'outbox_events'|'provider_calls';
export interface ContractEvidence {
  executedRealApp: boolean;
  requestCount: number;
  dbAssertionCount: number;
  verifiedAssertions: Array<{ claim: string; passed: boolean; evidence?: unknown }>;
  failures: string[];
}
export interface RepositoryHarness {
  seed(name:string):Promise<Fixture>;
  request(fixture:Fixture,input:Request):Promise<ApiResponse>;
  observe(fixture:Fixture,collection:ObservationName,where?:Record<string,unknown>):Promise<any[]>;
  runContractCase?(id:string,requirement:string):Promise<ContractEvidence>;
  dispose?():Promise<void>;
}
let loaded: RepositoryHarness | undefined;
export function repositoryHarness():RepositoryHarness {
  if (loaded) return loaded;
  // Repository binding: the real TrueCRM harness (owned disposable PostgreSQL + in-process route handlers) is the default.
  const locator=process.env.TRUECRM_CONTRACT_ADAPTER ?? 'tests/support/truecrm-contract-adapter.ts';
  if (!locator) throw new Error('CONTRACT TEST NOT WIRED: set TRUECRM_CONTRACT_ADAPTER to a repository-specific TestHarness implementing Testing/_harness/adapter.ts; do not skip these tests.');
  // Require here is deliberate: source package is portable to Jest/NestJS commonjs runner.
  // Agents using ESM may adapt the loader while preserving fail-closed behavior.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod=require(resolve(process.cwd(),locator));
  const candidate=typeof mod.createHarness==='function' ? mod.createHarness() : mod.harness;
  if (!candidate || typeof candidate.seed!=='function' || typeof candidate.request!=='function' || typeof candidate.observe!=='function') {
    throw new Error('CONTRACT TEST NOT WIRED: adapter must seed real DB fixtures, send real NestJS requests and inspect persisted state.');
  }
  loaded=candidate as RepositoryHarness;
  return loaded;
}
export async function verifyContractCase(id:string,requirement:string):Promise<void> {
  const h=repositoryHarness();
  if (!h.runContractCase) throw new Error(`CONTRACT TEST NOT WIRED: ${id} (${requirement}). Replace with real repository-specific arrange/act/assert, do not mark TODO.`);
  const e=await h.runContractCase(id,requirement);
  if (!e || !e.executedRealApp || e.requestCount<1 || e.dbAssertionCount<1 || !Array.isArray(e.verifiedAssertions) || e.verifiedAssertions.length<1) {
    throw new Error(`CONTRACT EVIDENCE INCOMPLETE: ${id}; a mock-only PASS is not adequate.`);
  }
  if (e.failures?.length || !e.verifiedAssertions.every(x=>x.passed)) {
    throw new Error(`CONTRACT FAIL: ${id}: ${JSON.stringify(e.failures||e.verifiedAssertions.filter(x=>!x.passed))}`);
  }
}
