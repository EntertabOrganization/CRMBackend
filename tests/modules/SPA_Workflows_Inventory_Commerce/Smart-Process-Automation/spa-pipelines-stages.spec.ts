/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Pipelines, Stages, Kanban and Transitions — unit/integration contract', () => {
  it('create and reorder pipelines/stages preserves existing item references', async () => { contract('create and reorder pipelines/stages preserves existing item references'); });
  it('reject moving item to stage belonging to different pipeline', async () => { contract('reject moving item to stage belonging to different pipeline'); });
  it('reject transition missing target-stage required field', async () => { contract('reject transition missing target-stage required field'); });
  it('reject unauthorized actor/stage permission', async () => { contract('reject unauthorized actor/stage permission'); });
  it('terminal success state closes Item and emits once', async () => { contract('terminal success state closes Item and emits once'); });
  it('optimistic racing drag-and-drop moves only one succeeds', async () => { contract('optimistic racing drag-and-drop moves only one succeeds'); });
  it('cannot archive stage/pipeline with live items without migration', async () => { contract('cannot archive stage/pipeline with live items without migration'); });
  it('kanban respects item and field visibility per viewer', async () => { contract('kanban respects item and field visibility per viewer'); });
});

export {};
