import { randomUUID } from 'node:crypto';
import { spaContractDatabase, contractFixture } from '@/tests/support/spa-contract';
const database = spaContractDatabase();

describe('SPA Scoped Roles, Stage/Field Access and Schema Security — unit/integration contract', () => {
  it('role with OWN scope sees only eligible Items', async () => {
    const f=await contractFixture(database()), own=await f.create('Owner'), m=await f.member({'SPA.ITEM.READ':'OWN'}); const theirs=await f.items.create(m.actor,f.type.id,{title:'Member',assignedUserId:m.user.id,fieldValues:{VALUE:'Member'}},randomUUID()); expect((await f.items.list(m.actor,f.type.id,{})).data.map(i=>i.id)).toEqual([theirs.id]); await expect(f.items.get(m.actor,f.type.id,own.id)).rejects.toMatchObject({status:403}); expect(await f.policies.allowed(database(),{...f.actor,workspaceId:randomUUID()},await database().spaItem.findUniqueOrThrow({where:{id:own.id}}),'SPA.ITEM.READ')).toBe(false);
  });
  it('stage edit policy can deny update despite Type update grant', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Old'); await f.matrix({stagePolicies:[{roleId:f.role.id,action:'SPA.ITEM.UPDATE',scope:'NONE',pipelineId:p.p.id,stageId:p.start.id}]}); await expect(f.items.update(f.actor,f.type.id,i.id,{expectedVersion:i.version,title:'Denied'})).rejects.toMatchObject({status:403}); expect((await f.items.get(f.actor,f.type.id,i.id)).title).toBe('Case');
  });
  it('field hidden from viewer absent from GET/list/export', async () => {
    const f=await contractFixture(database()), i=await f.create('Secret'); await f.hide(); expect((await f.items.get(f.actor,f.type.id,i.id)).fieldValues).toEqual({}); expect((await f.items.list(f.actor,f.type.id,{})).data[0].fieldValues).toEqual({}); const {SpaTransferService}=await import('@/src/server/spa/transfer-service'); await expect(new SpaTransferService(database()).queueExport(f.actor,f.type.id,{fieldCodes:['VALUE']})).rejects.toMatchObject({status:403});
  });
  it('field invisible cannot be used to infer value through filters', async () => {
    const f=await contractFixture(database()); await f.schemas.editField(f.actor,f.type.id,f.field.id,{isSearchable:true}); await f.publish(); await f.create('Hidden'); await f.hide(); await expect(f.items.list(f.actor,f.type.id,{filters:JSON.stringify([{fieldCode:'VALUE',operator:'CONTAINS',value:'H'}])})).rejects.toMatchObject({status:403});
  });
  it('observer read does not enable edit', async () => {
    const f=await contractFixture(database()), i=await f.create('Owner'), m=await f.member({'SPA.ITEM.READ':'OWN','SPA.ITEM.UPDATE':'OWN'}); await f.items.observer(f.actor,f.type.id,i.id,{userId:m.user.id}); expect((await f.items.get(m.actor,f.type.id,i.id)).id).toBe(i.id); await expect(f.items.update(m.actor,f.type.id,i.id,{expectedVersion:i.version+1,title:'Denied'})).rejects.toMatchObject({status:403});
  });
  it('permission update audited and cache invalidated', async () => {
    const f=await contractFixture(database()), i=await f.create('Visible'); await f.items.get(f.actor,f.type.id,i.id); const update=await f.matrix({rolePolicies:[{roleId:f.role.id,action:'SPA.ITEM.READ',scope:'NONE'}]}); expect(update.version).toBe(2); await expect(f.items.get(f.actor,f.type.id,i.id)).rejects.toMatchObject({status:403}); expect(await database().auditLog.count({where:{entityId:f.type.id,action:'SPA_PERMISSION_CHANGED'}})).toBe(1); expect((await f.policies.history(f.actor,f.type.id,{})).data).toHaveLength(1);
  });
  it('forged other Workspace role ID denied', async () => {
    const f=await contractFixture(database()), other=await contractFixture(database()); await expect(f.matrix({rolePolicies:[{roleId:other.role.id,action:'SPA.ITEM.READ',scope:'ALL'}]})).rejects.toMatchObject({status:422}); expect((await f.policies.matrix(f.actor,f.type.id)).rolePolicies).toEqual([]);
  });
});

export {};

