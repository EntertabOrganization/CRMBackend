/**
 * TrueCRM API E2E contract for Tasks & Projects — Domain Overview.
 * Replace contract() with real NestJS/Supertest (or repository-equivalent) assertions.
 */

export {};

import { overviewHttpScenarios } from '../support/overview-http';
const scenarios = overviewHttpScenarios('tasks');

describe('Tasks & Projects — Domain Overview E2E contract', () => {
  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    await scenarios['requires authenticated/authorized workspace context for protected endpoints']();
  });
  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    await scenarios['rejects cross-workspace resource access without leaking resource existence']();
  });
  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    await scenarios['returns stable machine-readable error envelopes for invalid requests']();
  });
  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    await scenarios['persists critical state and outbox/audit consistently on successful mutation']();
  });
});
