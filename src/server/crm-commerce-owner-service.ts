import { z } from 'zod';
import { AppError } from './errors';
import { InMemoryStore } from './store';
import { AccessService } from './access-service';
import { hydrateState,persistStateInTransaction } from './persistence';
import { CrmCoreService } from './crm-core-service';
import { CrmPipelineService } from './crm-pipeline-service';
import { DataQualityService } from './intelligence/data-quality';
import { SharedJobService } from './intelligence/shared';
import { FieldEngine } from './fields/field-engine';
import { createCrmFieldEntityRegistry } from './fields/entity-registry';
import { RealtimeHub } from './realtime';
import { UnconfiguredFilePort } from './ports';
import { requirePermission,type Principal,type Tx } from './process-platform/context';
import { ownerVisible } from './process-platform/owner-scope';
import { CrmReferenceReadService } from './crm-reference-read-service';

const snapshot=z.object({payerType:z.enum(['PERSON','COMPANY']),customer:z.object({name:z.string().trim().min(1).max(160),email:z.email(),phone:z.string().optional()})});
/** CRM owns identity resolution and all CRM writes, including field and stage requirements. */
export class CrmCommerceOwnerService {
  /** Explicit manual customer resolution uses the same normalized identity and
   * merge redirects as Order synchronization. Commerce never mutates CRM rows. */
  async resolveCustomerLink(tx:Tx,actor:Principal,email:string,type:'CONTACT'|'COMPANY',selectedId?:string){
    requirePermission(actor,'crm.'+type.toLowerCase()+'.read');
    const store=new InMemoryStore(await hydrateState(tx)),core=new CrmCoreService(store),access=new AccessService(store);
    const redirects=new DataQualityService(store,access,new SharedJobService(store));
    const candidates=[...new Set(core.resolveCustomerIdentity(actor.workspaceId,type,[{type:'EMAIL',value:email}]).map(id=>redirects.resolveRedirect(actor.workspaceId,type,id)))];
    if(!selectedId&&candidates.length!==1)throw new AppError('COMMERCE_CRM_IDENTITY_AMBIGUOUS','Select an explicit CRM customer to resolve the identity.',409);
    const targetId=redirects.resolveRedirect(actor.workspaceId,type,selectedId??candidates[0]);
    await new CrmReferenceReadService().read(tx,actor,type,targetId);
    return{targetId,resolution: selectedId?'MANUAL' as const:'MATCHED' as const,matchedIdentity:candidates.includes(targetId)};
  }
  async sync(tx:Tx,actor:Principal,source:{id:string;snapshot:unknown;currency:string;version:bigint},policy:string,pipelineId?:string){
    const input=snapshot.safeParse(source.snapshot);if(!input.success)throw new AppError('COMMERCE_CRM_CUSTOMER_INVALID','Customer snapshot is unavailable.',422);
    const store=new InMemoryStore(await hydrateState(tx)),before=store.cloneState(),access=new AccessService(store),registry=createCrmFieldEntityRegistry(store,access);
    const fields=new FieldEngine({store,access,registry,realtime:new RealtimeHub(),files:new UnconfiguredFilePort()}),core=new CrmCoreService(store,fields),crm=new CrmPipelineService(store,undefined,fields);
    const redirects=new DataQualityService(store,access,new SharedJobService(store)),user=store.state.users.find(u=>u.id===actor.userId&&!u.isDeleted&&u.status==='ACTIVE');
    if(!user)throw new AppError('PERMISSION_DENIED','Active CRM principal is required.',403);
    const type=input.data.payerType==='COMPANY'?'COMPANY' as const:'CONTACT' as const;
    const communications=[{type:'EMAIL' as const,value:input.data.customer.email},...(input.data.customer.phone?[{type:'PHONE' as const,value:input.data.customer.phone}]:[])];
    const visible=async(entity:'CONTACT'|'COMPANY'|'DEAL',id:string)=>{
      const key='crm.'+entity.toLowerCase()+'.read';requirePermission(actor,key);
      const adapter=registry.get(entity),record=adapter.findRecord(actor.workspaceId,id) as {responsibleUserId:string;isDeleted:boolean}|null;
      if(!record||record.isDeleted||!await ownerVisible(tx,actor,record.responsibleUserId,key)||!adapter.canRead(access.actor(user,actor.workspaceId),id))throw new AppError('CRM_REFERENCE_NOT_FOUND','CRM reference is unavailable.',404);
      return record;
    };
    requirePermission(actor,'crm.'+type.toLowerCase()+'.read');
    const binding=await tx.commerceCrmBinding.findUnique({where:{workspaceId_orderId_entityType:{workspaceId:actor.workspaceId,orderId:source.id,entityType:type}}});
    const candidates=Array.from(new Set(core.resolveCustomerIdentity(actor.workspaceId,type,communications).map(id=>redirects.resolveRedirect(actor.workspaceId,type,id))));
    if(candidates.length>1)throw new AppError('COMMERCE_CRM_IDENTITY_AMBIGUOUS','Customer identity requires review.',409);
    let customerId=binding?.targetId?redirects.resolveRedirect(actor.workspaceId,type,binding.targetId):candidates[0],customerWasNew=false;
    if(binding?.targetId&&candidates.length&&candidates[0]!==customerId)throw new AppError('COMMERCE_CRM_IDENTITY_CONFLICT','Customer binding requires review.',409);
    if(customerId)await visible(type,customerId);
    else{
      requirePermission(actor,'crm.'+type.toLowerCase()+'.create');
      customerId=type==='CONTACT'?core.createContactFromDisplayName(user,actor.workspaceId,{name:input.data.customer.name,communications}).id:core.createCompany(user,actor.workspaceId,{name:input.data.customer.name,communications}).id;
      customerWasNew=true;await visible(type,customerId);
    }
    const existing=store.state.crmDeals.find(d=>d.workspaceId===actor.workspaceId&&d.originSystem==='COMMERCE'&&d.originExternalId===source.id);
    const dealBinding=await tx.commerceCrmBinding.findUnique({where:{workspaceId_orderId_entityType:{workspaceId:actor.workspaceId,orderId:source.id,entityType:'DEAL'}}});
    if(dealBinding?.targetId&&existing?.id!==dealBinding.targetId)throw new AppError('COMMERCE_CRM_DEAL_CONFLICT','Deal binding requires review.',409);
    let dealId=existing?.id;
    if(existing){await visible('DEAL',existing.id);const rule=await tx.crmRoleStagePermission.findUnique({where:{roleId_stageId:{roleId:actor.roleId,stageId:existing.stageId}}});if(rule&&!rule.canView)throw new AppError('PERMISSION_DENIED','CRM stage access is required.',403);if(type==='COMPANY'?existing.companyId!==customerId:!store.state.crmDealContacts.some(r=>r.workspaceId===actor.workspaceId&&r.dealId===existing.id&&r.contactId===customerId))throw new AppError('COMMERCE_CRM_DEAL_CONFLICT','Deal customer requires review.',409);}
    else if(policy==='ALWAYS'||policy==='MANUAL_REVIEW'||policy==='ONLY_NEW_CUSTOMER'&&customerWasNew){
      requirePermission(actor,'crm.deal.create');requirePermission(actor,'crm.deal.read');
      const pipeline=store.state.crmPipelines.find(p=>p.workspaceId===actor.workspaceId&&p.entityType==='DEAL'&&p.isActive&&(pipelineId?p.id===pipelineId:p.isDefault));
      const stage=pipeline&&store.state.crmStages.find(s=>s.workspaceId===actor.workspaceId&&s.pipelineId===pipeline.id&&s.isDefault&&s.isActive);
      if(!pipeline||!stage)throw new AppError('COMMERCE_CRM_PIPELINE_UNAVAILABLE','CRM pipeline is unavailable.',409);
      const rule=await tx.crmRoleStagePermission.findUnique({where:{roleId_stageId:{roleId:actor.roleId,stageId:stage.id}}});
      if(rule&&(!rule.canView||!rule.canEnter))throw new AppError('PERMISSION_DENIED','CRM stage access is required.',403);
      // Exact Order money remains authoritative; legacy CRM Float amount is never populated.
      dealId=crm.createDeal(user,actor.workspaceId,{title:'Order '+source.id,pipelineId:pipeline.id,stageId:stage.id,currencyCode:source.currency,originSystem:'COMMERCE',originExternalId:source.id,originVersion:source.version.toString(),...(type==='COMPANY'?{companyId:customerId}:{contactIds:[customerId],primaryContactId:customerId})}).id;
      await visible('DEAL',dealId);
    }
    await persistStateInTransaction(tx,before,store.state);
    return{customerType:type,customerId,customerWasNew,dealId:dealId??null,dealCreated:!!dealId};
  }
}
