import { repositoryAdapter, Kind } from './repository-adapter';

const requiredLevel:Record<Kind,number> = {UNIT:0, INTEGRATION:1, E2E:2};

/** Executable but intentionally fail-closed until wired to real repository behavior. */
export async function verifyContractCase(id:string, expectation:string, minimumKind:Kind='INTEGRATION'):Promise<void> {
  const result = await repositoryAdapter.runCase({id,expectation,minimumKind});
  if (!result || result.pass !== true) throw new Error(`FAILED_CONTRACT: ${id} (${expectation})`);
  if (requiredLevel[result.kind] < requiredLevel[minimumKind]) throw new Error(`WRONG_EXECUTION_LEVEL: ${id}`);
  if (!Number.isInteger(result.assertionCount) || result.assertionCount < 2)
    throw new Error(`INSUFFICIENT_ASSERTIONS: ${id}. Verify business state AND relevant side effect/absence.`);
  if (!Array.isArray(result.observations) || result.observations.length < 2 ||
      !Array.isArray(result.implementationRefs) || result.implementationRefs.length < 1)
    throw new Error(`NO_REPOSITORY_EVIDENCE: ${id}. Return exact inspected state and changed code refs.`);
}
