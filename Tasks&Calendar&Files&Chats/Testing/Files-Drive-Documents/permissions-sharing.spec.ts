/**
 * TrueCRM executable contract test for File Permissions & Sharing Specification.
 * MUST be wired to the real repository implementation.
 */

import { fileSharingScenarios } from '../support/file-scenarios';

describe('File Permissions & Sharing Specification contract', () => {
  it('Inheritance override.', async () => {
    await fileSharingScenarios['Inheritance override.']();
  });
  it('Project role vs file override.', async () => {
    await fileSharingScenarios['Project role vs file override.']();
  });
  it('Expired/password/limit public link.', async () => {
    await fileSharingScenarios['Expired/password/limit public link.']();
  });
  it('Folder move out of public tree.', async () => {
    await fileSharingScenarios['Folder move out of public tree.']();
  });
});
