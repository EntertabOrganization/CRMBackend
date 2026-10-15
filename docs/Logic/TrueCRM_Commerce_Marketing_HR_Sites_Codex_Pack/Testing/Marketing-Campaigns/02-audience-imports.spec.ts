import { verifyContractCase } from '../_harness/adapter';

describe('Imported audience identities and matching (contract)', () => {
  it('Bad row partial-success reported', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::AC01', "Bad row partial-success reported");
  });
  it('Reimport same list does not duplicate identities', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::AC02', "Reimport same list does not duplicate identities");
  });
  it('No send without required consent even after successful import', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::AC03', "No send without required consent even after successful import");
  });
  it('cross-tenant resource denial with foreign UUID and no data exposure', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::S01', "cross-tenant resource denial with foreign UUID and no data exposure");
  });
  it('invalid permissions leave domain state, audit and outbox unchanged', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::S02', "invalid permissions leave domain state, audit and outbox unchanged");
  });
  it('same-key retry is exactly-once-effective and creates no duplicate provider effect', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::S03', "same-key retry is exactly-once-effective and creates no duplicate provider effect");
  });
  it('authorized mutation commits state, redacted audit and outbox event together', async () => {
    await verifyContractCase('Marketing-Campaigns/02-audience-imports::S04', "authorized mutation commits state, redacted audit and outbox event together");
  });
});
