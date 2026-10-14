import { randomUUID } from 'node:crypto';
import { spaContractDatabase, contractFixture } from '@/tests/support/spa-contract';
const database = spaContractDatabase();

describe('SPA Types and Capabilities — unit/integration contract', () => {
  it('create type with unique code, draft state and capability defaults', async () => {
    const f=await contractFixture(database()); const t=await f.types.create(f.actor,{code:'NEW_CASES',name:'Case',pluralName:'Cases',placement:'CRM'}); expect(t.status).toBe('DRAFT'); const flags=await f.types.capabilities(f.actor,t.id); expect(flags).toHaveLength(13); expect(flags.filter(c=>c.enabled).map(c=>c.key).sort()).toEqual(['ACTIVITIES','NUMBERING','OBSERVERS','RECYCLE_BIN']); expect(await database().spaSchemaDraft.count({where:{typeId:t.id}})).toBe(1); expect(await database().outboxEvent.count({where:{entityId:t.id,eventType:'SPA_TYPE_CREATED'}})).toBe(1);
  });
  it('activate type with valid published schema and default pipeline', async () => {
    const f=await contractFixture(database()); const t=await f.types.create(f.actor,{code:'PIPE_CASES',name:'Case',pluralName:'Cases',placement:'CRM',capabilities:[{key:'PIPELINES',enabled:true}]}); await expect(f.types.transition(f.actor,t.id,'activate',{expectedVersion:t.version})).rejects.toMatchObject({code:'SPA_SCHEMA_NOT_PUBLISHED'}); await f.schemas.publish(f.actor,t.id,{expectedDraftVersion:1}); let live=await f.types.get(f.actor,t.id); await expect(f.types.transition(f.actor,t.id,'activate',{expectedVersion:live.version})).rejects.toMatchObject({code:'SPA_CAPABILITY_DEPENDENCY'}); await f.pipelines.create(f.actor,t.id,{code:'MAIN',name:'Main'}); live=await f.types.get(f.actor,t.id); expect(await f.types.transition(f.actor,t.id,'activate',{expectedVersion:live.version})).toMatchObject({status:'ACTIVE'});
  });
  it('reject duplicate code and invalid code format', async () => {
    const f=await contractFixture(database()), count=await database().spaEntityType.count(); for(const [code,status] of [['SCHEMA_CASES',409],['bad code',400]] as const) await expect(f.types.create(f.actor,{code,name:'Case',pluralName:'Cases',placement:'CRM'})).rejects.toMatchObject({status}); expect(await database().spaEntityType.count()).toBe(count);
  });
  it('reject KANBAN when pipelines disabled', async () => {
    const f=await contractFixture(database()), t=await f.types.get(f.actor,f.type.id); await expect(f.types.setCapability(f.actor,t.id,'KANBAN',{expectedVersion:t.version,enabled:true,configuration:{}})).rejects.toMatchObject({code:'SPA_CAPABILITY_DEPENDENCY'});
  });
  it('reject disable capabilities while live dependent data remain', async () => {
    const f=await contractFixture(database()); await f.create('Live'); const t=await f.types.get(f.actor,f.type.id); await expect(f.types.setCapability(f.actor,t.id,'NUMBERING',{expectedVersion:t.version,enabled:false,configuration:{}})).rejects.toMatchObject({code:'SPA_CAPABILITY_IN_USE'}); expect((await f.types.capabilities(f.actor,t.id)).find(c=>c.key==='NUMBERING')?.enabled).toBe(true);
  });
  it('archived type rejects item creation but permits authorized historical read', async () => {
    const f=await contractFixture(database()), item=await f.create('History'), t=await f.types.get(f.actor,f.type.id); await f.types.transition(f.actor,t.id,'archive',{expectedVersion:t.version}); await expect(f.create('New')).rejects.toMatchObject({status:409}); expect(await f.items.get(f.actor,t.id,item.id)).toMatchObject({id:item.id,fieldValues:{VALUE:'History'}});
  });
  it('cross-workspace type ID not accessible', async () => {
    const f=await contractFixture(database()), other=await contractFixture(database()); await expect(f.types.get(f.actor,other.type.id)).rejects.toMatchObject({status:404}); expect((await f.types.list(f.actor,{})).data.map(t=>t.id)).toEqual([f.type.id]);
  });
  it('type management denied without SPA.TYPE.MANAGE', async () => {
    const f=await contractFixture(database()), grants=new Map(f.actor.grants); grants.delete('SPA.TYPE.MANAGE'); await expect(f.types.update({...f.actor,grants},f.type.id,{expectedVersion:3,name:'Denied'})).rejects.toMatchObject({status:403});
  });
  it('stale expectedVersion returns 409 and produces no outbox event', async () => {
    const f=await contractFixture(database()), t=await f.types.get(f.actor,f.type.id), before=await database().outboxEvent.count({where:{entityId:t.id}}); await expect(f.types.update(f.actor,t.id,{expectedVersion:t.version-1,name:'Stale'})).rejects.toMatchObject({status:409}); expect(await database().outboxEvent.count({where:{entityId:t.id}})).toBe(before); expect((await f.types.get(f.actor,t.id)).name).toBe(t.name);
  });
});

export {};
