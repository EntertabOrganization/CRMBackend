/**
 * TrueCRM executable contract test for Calendar & Meetings — Domain Overview.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Calendar & Meetings — Domain Overview contract', () => {
  it('Timezone/all-day semantics.', async () => {
    contract('Timezone/all-day semantics.');
  });
  it('Recurring exception identity.', async () => {
    contract('Recurring exception identity.');
  });
  it('Double-booking races.', async () => {
    contract('Double-booking races.');
  });
  it('Public booking privacy.', async () => {
    contract('Public booking privacy.');
  });
  it('Provider sync conflict and retry.', async () => {
    contract('Provider sync conflict and retry.');
  });
});
