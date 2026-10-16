/**
 * Coding agent MUST replace this with an adapter bound to the real repository:
 * real DB transactions, Nest controllers/services, external provider test sandbox,
 * job queues and observable audit/outbox state. NEVER return fake pass evidence.
 */
export type Kind = 'UNIT' | 'INTEGRATION' | 'E2E';
export interface CaseEvidence {
  pass: boolean;
  kind: Kind;
  assertionCount: number;
  observations: string[];
  implementationRefs: string[];
}
export interface ContractRepositoryAdapter {
  runCase(input:{id:string; expectation:string; minimumKind:Kind}):Promise<CaseEvidence>;
}
export const repositoryAdapter: ContractRepositoryAdapter = {
  async runCase(input) {
    throw new Error(`CONTRACT_NOT_WIRED: ${input.id}. Implement an actual repository fixture and assertions for: ${input.expectation}`);
  }
};
