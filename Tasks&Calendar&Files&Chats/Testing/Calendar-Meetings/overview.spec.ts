/**
 * TrueCRM executable contract test for Calendar & Meetings — Domain Overview.
 * MUST be wired to the real repository implementation.
 */

import { calendarOverviewScenarios } from '../support/calendar-scenarios';

describe('Calendar & Meetings — Domain Overview contract', () => {
  it('Timezone/all-day semantics.', async () => {
    await calendarOverviewScenarios['Timezone/all-day semantics.']();
  });
  it('Recurring exception identity.', async () => {
    await calendarOverviewScenarios['Recurring exception identity.']();
  });
  it('Double-booking races.', async () => {
    await calendarOverviewScenarios['Double-booking races.']();
  });
  it('Public booking privacy.', async () => {
    await calendarOverviewScenarios['Public booking privacy.']();
  });
  it('Provider sync conflict and retry.', async () => {
    await calendarOverviewScenarios['Provider sync conflict and retry.']();
  });
});
