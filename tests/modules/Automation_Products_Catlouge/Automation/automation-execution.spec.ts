const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Automation execution reliability', () => {
  it('executes all independently matching rules', () => contract('one source event can create independent executions for all matching Rules'));
  it('pins delayed jobs to the creating rule revision', () => contract('job uses original revision after newer revision publish'));
  it('rechecks stale current-state conditions before delayed side effects', () => contract('stale delayed job is skipped with reason'));
  it('executes actions in configured order', () => contract('Action execution order is deterministic'));
  it('stops on action failure by default', () => contract('later Actions do not run after failed Action unless continueOnError'));
  it('supports explicit continueOnError with partial status', () => contract('execution records partial failure instead of false success'));
  it('retries only retryable failures', () => contract('validation/permission failures do not retry forever'));
  it('resumes from failed action without duplicating successful side effects', () => contract('action idempotency on execution retry'));
  it('prevents duplicate execution for duplicate source event delivery', () => contract('Rule revision + event + target dedupe'));
  it('blocks loops/depth overflow', () => contract('correlated automation chain terminates at configured safety limit'));
});

export {};
