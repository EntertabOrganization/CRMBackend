import { randomUUID } from 'node:crypto';
import { spaContractDatabase, contractFixture } from '@/tests/support/spa-contract';
const database = spaContractDatabase();

describe('SPA Items, Assignments and Item History — unit/integration contract', () => {
  it('create Item persists number, values and history atomically', async () => {
    const f=await contractFixture(database()), i=await f.create('Persisted'); expect(i.itemNumber).toMatch(/SCHEMA_CASES-/); expect(await database().spaItemValue.findFirst({where:{itemId:i.id,fieldId:f.field.id}})).toMatchObject({valueText:'Persisted'}); expect(await database().spaHistory.count({where:{itemId:i.id,action:'SPA_ITEM_CREATED'}})).toBe(1); expect(await database().outboxEvent.count({where:{entityId:i.id,eventType:'SPA_ITEM_CREATED'}})).toBe(1);
  });
  it('unknown field or wrong metadata type rejects before DB mutation', async () => {
    const f=await contractFixture(database()); for(const fieldValues of [{UNKNOWN:'bad'},{VALUE:42}]) await expect(f.items.create(f.actor,f.type.id,{title:'Invalid',assignedUserId:f.user.id,fieldValues},randomUUID())).rejects.toMatchObject({status:expect.any(Number)}); expect(await database().spaItem.count({where:{typeId:f.type.id}})).toBe(0); expect(await database().spaNumberingSequence.count({where:{typeId:f.type.id}})).toBe(0);
  });
  it('invalid assignment user in different workspace denied', async () => {
    const f=await contractFixture(database()), other=await contractFixture(database()); await expect(f.items.create(f.actor,f.type.id,{title:'Invalid',assignedUserId:other.user.id,fieldValues:{VALUE:'x'}},randomUUID())).rejects.toMatchObject({status:422}); expect(await database().spaItem.count({where:{typeId:f.type.id}})).toBe(0);
  });
  it('SPA Item view redacts restricted fields even with base read access', async () => {
    const f=await contractFixture(database()), i=await f.create('Secret'); await f.hide(); expect((await f.items.get(f.actor,f.type.id,i.id)).fieldValues).toEqual({}); expect((await f.items.permissionsMe(f.actor,f.type.id,i.id)).visibleFields).not.toContain('VALUE');
  });
  it('optimistic version conflict returns 409 without partial field writes', async () => {
    const f=await contractFixture(database()), i=await f.create('Old'); await f.items.update(f.actor,f.type.id,i.id,{expectedVersion:i.version,fieldValues:{VALUE:'New'}}); const before=await database().outboxEvent.count({where:{entityId:i.id}}); await expect(f.items.update(f.actor,f.type.id,i.id,{expectedVersion:i.version,fieldValues:{VALUE:'Lost'}})).rejects.toMatchObject({status:409}); expect((await f.items.get(f.actor,f.type.id,i.id)).fieldValues.VALUE).toBe('New'); expect(await database().outboxEvent.count({where:{entityId:i.id}})).toBe(before);
  });
  it('observer read grant does not confer field edit', async () => {
    const f=await contractFixture(database()), i=await f.create('Secret'), m=await f.member({'SPA.ITEM.READ':'OWN','SPA.ITEM.UPDATE':'OWN'}); await f.items.observer(f.actor,f.type.id,i.id,{userId:m.user.id}); expect((await f.items.get(m.actor,f.type.id,i.id)).id).toBe(i.id); await expect(f.items.update(m.actor,f.type.id,i.id,{expectedVersion:i.version+1,title:'Denied'})).rejects.toMatchObject({status:403}); expect((await f.items.permissionsMe(m.actor,f.type.id,i.id)).editableFields).toEqual([]);
  });
  it('trash and restore preserve audit and linked shared files', async () => {
    const f=await contractFixture(database()), source=await f.create('Source'), target=await f.create('Target'); const {SpaRelationService}=await import('@/src/server/spa/relation-service'); const r=new SpaRelationService(database()); const d=await r.addDefinition(f.actor,f.type.id,{code:'RELATED',name:'Related',targetType:'SPA_ITEM',targetSubtypeId:f.type.id,cardinality:'MANY'}); await f.publish(); await r.link(f.actor,f.type.id,source.id,{definitionId:d.id,targetType:'SPA_ITEM',targetId:target.id}); const current=await f.items.get(f.actor,f.type.id,source.id); const deleted=await f.items.lifecycle(f.actor,f.type.id,source.id,{expectedVersion:current.version}); expect(await database().spaItemRelation.count({where:{sourceItemId:source.id}})).toBe(1); const restored=await f.items.lifecycle(f.actor,f.type.id,source.id,{expectedVersion:deleted.version},true); expect(restored).toMatchObject({status:'ACTIVE'}); expect(await database().spaHistory.count({where:{itemId:source.id,action:{in:['SPA_ITEM_TRASHED','SPA_ITEM_RESTORED']}}})).toBe(2); expect(await database().spaItemRelation.count({where:{sourceItemId:source.id}})).toBe(1);
  });
  it('creating Item on archived Type fails', async () => {
    const f=await contractFixture(database()), t=await f.types.get(f.actor,f.type.id); await f.types.transition(f.actor,t.id,'archive',{expectedVersion:t.version}); await expect(f.create('Denied')).rejects.toMatchObject({status:409}); expect(await database().spaItem.count({where:{typeId:t.id}})).toBe(0);
  });
  it('search filters do not reveal unauthorized field values', async () => {
    const f=await contractFixture(database()); await f.schemas.editField(f.actor,f.type.id,f.field.id,{isSearchable:true}); await f.publish(); await f.create('Secret'); await f.hide(); for(const value of ['Secret','Guess']) await expect(f.items.list(f.actor,f.type.id,{filters:JSON.stringify([{fieldCode:'VALUE',operator:'EQ',value}])})).rejects.toMatchObject({status:403}); expect((await f.items.list(f.actor,f.type.id,{})).data[0].fieldValues).toEqual({});
  });
});

export {};

