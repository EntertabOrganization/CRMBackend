import { contract } from '../harness';

describe('Audit/retention/security contract', () => {
  it('critical mutation produces sanitized immutable audit evidence', async () => {
    await contract('central audit');
  });
  it('audit contains no reusable credential secret', async () => {
    await contract('audit secret redaction');
  });
  it('retention job does not purge legal-held evidence', async () => {
    await contract('legal hold');
  });
  it('archived model/rule remains resolvable by historical result', async () => {
    await contract('historical configuration retention');
  });
  it('export artifact expires independently from retained job metadata', async () => {
    await contract('artifact vs metadata retention');
  });
  it('detailed provider payload retention follows policy', async () => {
    await contract('integration payload retention');
  });
});
