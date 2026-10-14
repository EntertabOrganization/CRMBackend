import { randomUUID } from 'node:crypto';
import { spaContractDatabase, contractFixture } from '@/tests/support/spa-contract';
const database = spaContractDatabase();

describe('SPA Pipelines, Stages, Kanban and Transitions — unit/integration contract', () => {
  it('create and reorder pipelines/stages preserves existing item references', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Bound'); await f.pipelines.update(f.actor,f.type.id,p.p.id,{expectedVersion:p.p.version,name:'Renamed',sortOrder:5}); await f.pipelines.updateStage(f.actor,f.type.id,p.p.id,p.start.id,{expectedVersion:p.start.version,sortOrder:9}); expect(await database().spaItem.findUnique({where:{id:i.id}})).toMatchObject({pipelineId:p.p.id,stageId:p.start.id}); expect((await f.pipelines.stages(f.actor,f.type.id,p.p.id)).at(-1)?.id).toBe(p.start.id);
  });
  it('reject moving item to stage belonging to different pipeline', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Bound'), other=await f.pipelines.create(f.actor,f.type.id,{code:'OTHER',name:'Other'}); await expect(f.items.transition(f.actor,f.type.id,i.id,{expectedVersion:i.version,targetPipelineId:other.id,targetStageId:p.success.id})).rejects.toMatchObject({status:422}); expect((await f.items.get(f.actor,f.type.id,i.id)).stageId).toBe(p.start.id);
  });
  it('reject transition missing target-stage required field', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create(null); await database().spaStage.update({where:{id:p.success.id},data:{requirements:['VALUE']}}); await expect(f.items.transition(f.actor,f.type.id,i.id,{expectedVersion:i.version,targetPipelineId:p.p.id,targetStageId:p.success.id})).rejects.toMatchObject({code:'SPA_STAGE_REQUIRED_FIELDS'}); expect((await f.items.get(f.actor,f.type.id,i.id)).version).toBe(i.version);
  });
  it('reject unauthorized actor/stage permission', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Bound'); await f.matrix({stagePolicies:[{roleId:f.role.id,action:'SPA.ITEM.STAGE_CHANGE',scope:'NONE',pipelineId:p.p.id,stageId:p.success.id}]}); await expect(f.items.transition(f.actor,f.type.id,i.id,{expectedVersion:i.version,targetPipelineId:p.p.id,targetStageId:p.success.id})).rejects.toMatchObject({status:403}); expect((await f.items.get(f.actor,f.type.id,i.id)).stageId).toBe(p.start.id);
  });
  it('terminal success state closes Item and emits once', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Bound'), input={expectedVersion:i.version,targetPipelineId:p.p.id,targetStageId:p.success.id}; const closed=await f.items.transition(f.actor,f.type.id,i.id,input); expect(closed.status).toBe('COMPLETED'); expect(closed.closedAt).toBeInstanceOf(Date); await expect(f.items.transition(f.actor,f.type.id,i.id,input)).rejects.toMatchObject({status:409}); expect(await database().outboxEvent.count({where:{entityId:i.id,eventType:'SPA_ITEM_STAGE_CHANGED'}})).toBe(1);
  });
  it('optimistic racing drag-and-drop moves only one succeeds', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(), i=await f.create('Race'); const results=await Promise.allSettled(p.stages.filter(s=>s.id!==p.start.id).map(s=>f.items.transition(f.actor,f.type.id,i.id,{expectedVersion:i.version,targetPipelineId:p.p.id,targetStageId:s.id}))); expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1); const denied=results.find(r=>r.status==='rejected') as PromiseRejectedResult; expect(denied.reason.status).toBe(409); expect(await database().outboxEvent.count({where:{entityId:i.id,eventType:'SPA_ITEM_STAGE_CHANGED'}})).toBe(1);
  });
  it('cannot archive stage/pipeline with live items without migration', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(); await f.create('Live'); await expect(f.pipelines.archive(f.actor,f.type.id,p.p.id,{},p.start.id)).rejects.toMatchObject({code:'SPA_STAGE_HAS_ITEMS'}); await expect(f.pipelines.archive(f.actor,f.type.id,p.p.id,{expectedVersion:p.p.version})).rejects.toMatchObject({code:'SPA_PIPELINE_HAS_ITEMS'}); expect(await database().spaPipeline.findUnique({where:{id:p.p.id}})).toMatchObject({status:'ACTIVE'});
  });
  it('kanban respects item and field visibility per viewer', async () => {
    const f=await contractFixture(database()), p=await f.pipeline(); await f.create('Owner'); const m=await f.member({'SPA.ITEM.READ':'OWN'}), i=await f.items.create(m.actor,f.type.id,{title:'Member',assignedUserId:m.user.id,fieldValues:{VALUE:'Hidden'}},randomUUID()); await f.matrix({fieldPolicies:[{fieldId:f.field.id,subjectType:'ROLE',subjectId:m.role.id,canView:false,canEdit:false}]}); const board=await f.items.kanban(m.actor,f.type.id,{pipelineId:p.p.id}); expect(board.columns.flatMap(c=>c.items).map(x=>x.id)).toEqual([i.id]); expect(board.columns.flatMap(c=>c.items)[0].fieldValues).toEqual({}); expect(board.columns.reduce((sum,c)=>sum+c.count,0)).toBe(1);
  });
});

export {};
