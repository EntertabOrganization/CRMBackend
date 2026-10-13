/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Stock Availability, Immutable Ledger and Rebuild — unit/integration contract', () => {
  it('receipt +10 yields onHand10,available10', async () => { contract('receipt +10 yields onHand10,available10'); });
  it('reserve 4 keeps onHand10,reserved4,available6', async () => { contract('reserve 4 keeps onHand10,reserved4,available6'); });
  it('movement table rejects update/delete even by normal admin API', async () => { contract('movement table rejects update/delete even by normal admin API'); });
  it('simultaneous reservations against final unit cannot oversell under default', async () => { contract('simultaneous reservations against final unit cannot oversell under default'); });
  it('ledger replay matches balance across receipt/transfer/reversal', async () => { contract('ledger replay matches balance across receipt/transfer/reversal'); });
  it('wrong workspace SKU or warehouse not visible', async () => { contract('wrong workspace SKU or warehouse not visible'); });
  it('service product forbidden for stock movement', async () => { contract('service product forbidden for stock movement'); });
  it('NUMERIC precision preserved for fractional quantities', async () => { contract('NUMERIC precision preserved for fractional quantities'); });
});

export {};
