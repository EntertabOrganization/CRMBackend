import { AppError } from './errors';
import { AccessService } from './access-service';
import { InMemoryStore } from './store';
import { hydrateState } from './persistence';
import { createCrmFieldEntityRegistry } from './fields/entity-registry';
import { requirePermission,type Principal,type Tx } from './process-platform/context';
import { ownerVisible } from './process-platform/owner-scope';

/** Shared CRM owns reference visibility. Only safe identity/version is projected to Commerce. */
export class CrmReferenceReadService {
  async inspect(tx:Tx,actor:Principal,type:'CONTACT'|'COMPANY'|'DEAL',id:string){
    const permission='crm.'+type.toLowerCase()+'.read';requirePermission(actor,permission);
    const record=type==='CONTACT'?await tx.crmContact.findFirst({where:{workspaceId:actor.workspaceId,id}}):type==='COMPANY'?await tx.crmCompany.findFirst({where:{workspaceId:actor.workspaceId,id}}):await tx.crmDeal.findFirst({where:{workspaceId:actor.workspaceId,id}});
    if(!record){if(actor.grants.get(permission)!=='WORKSPACE')throw new AppError('CRM_REFERENCE_NOT_FOUND','CRM reference is unavailable.',404);return{available:false};}
    if(!await ownerVisible(tx,actor,record.responsibleUserId,permission))throw new AppError('CRM_REFERENCE_NOT_FOUND','CRM reference is unavailable.',404);
    if(record.isDeleted)return{available:false};
    await this.read(tx,actor,type,id);return{available:true};
  }
  async read(tx:Tx,actor:Principal,type:'CONTACT'|'COMPANY'|'DEAL',id:string){
    const permission='crm.'+type.toLowerCase()+'.read';requirePermission(actor,permission);
    const store=new InMemoryStore(await hydrateState(tx)),access=new AccessService(store),adapter=createCrmFieldEntityRegistry(store,access).get(type);
    const user=store.state.users.find(u=>u.id===actor.userId&&!u.isDeleted&&u.status==='ACTIVE'),record=adapter.findRecord(actor.workspaceId,id) as {id:string;responsibleUserId:string;version:number;isDeleted:boolean}|null;
    if(!user||!record||record.isDeleted||!await ownerVisible(tx,actor,record.responsibleUserId,permission)||!adapter.canRead(access.actor(user,actor.workspaceId),id))throw new AppError('CRM_REFERENCE_NOT_FOUND','CRM reference is unavailable.',404);
    return{id:record.id,version:record.version};
  }
}
