import { contract } from '../harness';

describe('Import undo contract', () => {
  it('allows reversal only when post-import state is still safe', async () => {
    await contract('safe undo eligibility');
  });
  it('refuses to delete imported record with protected subsequent business activity', async () => {
    await contract('unsafe created-record undo');
  });
  it('refuses to overwrite a field changed after import', async () => {
    await contract('post-import concurrent change');
  });
  it('reports partial/row-level undo outcomes without pretending full rollback', async () => {
    await contract('partial undo reporting');
  });
  it('audits executed/refused undo actions', async () => {
    await contract('import undo audit');
  });
});
