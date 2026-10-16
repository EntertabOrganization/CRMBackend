import { verifyContractCase } from '../_harness/adapter';

describe('Cart, checkout sessions and order creation (contract)', () => {
  it('No duplicate order from 5 same-key retries', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::AC01', "No duplicate order from 5 same-key retries");
  });
  it('Different payload same idempotency key returns 409', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::AC02', "Different payload same idempotency key returns 409");
  });
  it('Changed server price requires refreshed quote', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::AC03', "Changed server price requires refreshed quote");
  });
  it('2 simultaneous checkouts cannot oversell', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::AC04', "2 simultaneous checkouts cannot oversell");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('OnlineStore-Commerce/04-carts-and-checkout::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
