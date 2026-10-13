import { type PrismaClient,type CommerceStore,type CommerceOrder } from '@prisma/client';
import { AppError } from '../errors';
import { verifyAccessToken } from '../security';
import { parse,pageQuery,uuid } from '../process-platform/dto';
import { lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { CommerceStoreService } from './store-service';
import { CommercePublicationService } from './publication-service';
import { z } from 'zod';
import { CrmCommerceOwnerService } from '../crm-commerce-owner-service';
import { evidence } from '../process-platform/context';
import { CommerceCartService } from './cart-service';
import { checkRateLimit } from '../rate-limit';

export function customerOrderProjection(row:CommerceOrder){
  return {id:row.id,status:row.status,paymentStatus:row.paymentStatus,currency:row.currency,total:row.total.toFixed(6),createdAt:row.createdAt};
}
const pagination=(page:number,limit:number,total:number)=>({page,limit,total,totalPages:Math.ceil(total/limit)});
/** Uses the owning Auth identity, never employee membership or caller email as proof. */
export async function customerIdentity(tx:Tx,authorization:string|null){
  if(!authorization?.startsWith('Bearer '))throw new AppError('UNAUTHENTICATED','Customer authentication is required.',401);
  const id=await verifyAccessToken(authorization.slice(7));
  const identity=await tx.user.findFirst({where:{id,status:'ACTIVE',isDeleted:false,emailVerifiedAt:{not:null}}});
  if(!identity)throw new AppError('UNAUTHENTICATED','A verified active customer identity is required.',401);
  return identity;
}
export async function checkoutCustomer(tx:Tx,store:CommerceStore,authorization:string|null,email:string){
  if(!authorization)return null;
  const identity=await customerIdentity(tx,authorization);
  if(identity.email.trim().toLowerCase()!==email)throw new AppError('COMMERCE_CUSTOMER_ACCESS_DENIED','Checkout email must match the verified identity.',403);
  await lock(tx,store.workspaceId,'commerce:customer:'+store.id+':'+identity.id);
  const account=await tx.commerceCustomerAccount.upsert({where:{workspaceId_storeId_identityAuthId:{workspaceId:store.workspaceId,storeId:store.id,identityAuthId:identity.id}},create:{workspaceId:store.workspaceId,storeId:store.id,identityAuthId:identity.id,emailNormalized:email},update:{}});
  if(account.status!=='ACTIVE')throw new AppError('COMMERCE_CUSTOMER_ACCESS_DENIED','Customer account is disabled.',403);
  return account;
}
export class CommerceCustomerService {
  constructor(private readonly db:PrismaClient,readonly stores=new CommerceStoreService(db),readonly publications=new CommercePublicationService(db,stores)){}
  async account(tx:Tx,actor:Principal,id:string,permission:string){
    parse(uuid,id);requirePermission(actor,permission);
    const account=await tx.commerceCustomerAccount.findFirst({where:{workspaceId:actor.workspaceId,id}});
    if(!account)throw new AppError('COMMERCE_CUSTOMER_NOT_FOUND','Customer was not found.',404);
    await this.stores.store(tx,actor,account.storeId,permission);return account;
  }
  async list(actor:Principal,raw:unknown){
    const query=parse(pageQuery,raw);
    return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);requirePermission(actor,'COMMERCE.CUSTOMER_VIEW');
      const stores=await tx.commerceStore.findMany({where:{workspaceId:actor.workspaceId}}),ids:string[]=[];
      for(const store of stores)try{await this.stores.store(tx,actor,store.id,'COMMERCE.CUSTOMER_VIEW');ids.push(store.id);}catch(error){if(!(error instanceof AppError)||![403,404].includes(error.status))throw error;}
      // CUSTOMER_VIEW explicitly permits customer email; no identity IDs, phone,
      // address, CRM bindings or Order snapshots are included or searchable.
      const where={workspaceId:actor.workspaceId,storeId:{in:ids},...(query.search?{emailNormalized:{contains:query.search.toLowerCase()}}:{})};
      const [data,total]=await Promise.all([tx.commerceCustomerAccount.findMany({where,select:{id:true,storeId:true,emailNormalized:true,status:true,createdAt:true},orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(query.page-1)*query.limit,take:query.limit}),tx.commerceCustomerAccount.count({where})]);
      return{data,meta:pagination(query.page,query.limit,total)};
    },{timeout:60000});
  }
  async orders(actor:Principal,id:string,raw:unknown){
    const query=parse(pageQuery.omit({search:true}),raw);
    return this.db.$transaction(async tx=>{
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const account=await this.account(tx,actor,id,'COMMERCE.CUSTOMER_VIEW');
      return this.purchaseHistory(tx,account,query);
    });
  }
  async link(actor:Principal,id:string,raw:unknown){
    const input=parse(z.strictObject({contactId:uuid.optional(),companyId:uuid.optional(),resolutionReason:z.string().trim().min(1).max(2000)}),raw);
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.workspaceId,'commerce:configuration');await lock(tx,actor.workspaceId,'commerce:customer-link:'+id);
      actor=await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const account=await this.account(tx,actor,id,'COMMERCE.CUSTOMER_MANAGE');
      if(account.status!=='ACTIVE')throw new AppError('COMMERCE_CUSTOMER_ACCESS_DENIED','Customer account is disabled.',409);
      const selections: {type:'CONTACT'|'COMPANY';id?:string}[]=input.contactId||input.companyId?[...(input.contactId?[{type:'CONTACT' as const,id:input.contactId}]:[]),...(input.companyId?[{type:'COMPANY' as const,id:input.companyId}]:[])]:[{type:'CONTACT'}];
      const data=[];
      for(const selection of selections){
        const result=await new CrmCommerceOwnerService().resolveCustomerLink(tx,actor,account.emailNormalized,selection.type,selection.id);
        const identity={workspaceId:actor.workspaceId,customerAccountId:id,entityType:selection.type};
        const prior=await tx.commerceCustomerBinding.findUnique({where:{workspaceId_customerAccountId_entityType:identity}});
        if(prior&&(prior.contactId??prior.companyId)===result.targetId){data.push({type:selection.type,targetId:result.targetId,version:prior.version.toString()});continue;}
        const values={contactId:selection.type==='CONTACT'?result.targetId:null,companyId:selection.type==='COMPANY'?result.targetId:null,resolutionReason:input.resolutionReason,linkedByUserId:actor.userId};
        const binding=await tx.commerceCustomerBinding.upsert({where:{workspaceId_customerAccountId_entityType:identity},create:{...identity,storeId:account.storeId,...values},update:{...values,version:{increment:1}}});
        await evidence(tx,actor,'COMMERCE_CUSTOMER',id,'COMMERCE_CUSTOMER_LINKED',{storeId:account.storeId,type:selection.type,targetId:result.targetId,previousTargetId:prior?.contactId??prior?.companyId??null,resolution:result.resolution,matchedIdentity:result.matchedIdentity,resolutionReason:input.resolutionReason,version:binding.version.toString()});
        data.push({type:selection.type,targetId:result.targetId,version:binding.version.toString()});
      }
      return{customerId:id,bindings:data};
    },{timeout:60000});
  }
  async session(tx:Tx,store:CommerceStore,authorization:string|null){
    const identity=await customerIdentity(tx,authorization);
    const account=await tx.commerceCustomerAccount.findUnique({where:{workspaceId_storeId_identityAuthId:{workspaceId:store.workspaceId,storeId:store.id,identityAuthId:identity.id}}});
    if(!account||account.status!=='ACTIVE')throw new AppError('COMMERCE_CUSTOMER_ACCESS_DENIED','Customer account is unavailable.',403);
    return account;
  }
  private async purchaseHistory(tx:Tx,account:{workspaceId:string;storeId:string;id:string},query:{page:number;limit:number}){
    const where={workspaceId:account.workspaceId,storeId:account.storeId,customerAccountId:account.id};
    const [rows,total]=await Promise.all([tx.commerceOrder.findMany({where,orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(query.page-1)*query.limit,take:query.limit}),tx.commerceOrder.count({where})]);
    return{data:rows.map(customerOrderProjection),meta:pagination(query.page,query.limit,total)};
  }
  async ownOrders(slug:string,authorization:string|null,raw:unknown){
    const query=parse(pageQuery.omit({search:true}),raw);
    return this.db.$transaction(async tx=>{
      const {store}=await this.publications.publicScope(tx,slug);
      return this.purchaseHistory(tx,await this.session(tx,store,authorization),query);
    });
  }
  async reorder(slug:string,id:string,authorization:string|null,raw:unknown){
    parse(uuid,id);parse(z.strictObject({}),raw);
    return this.db.$transaction(async tx=>{
      const scope=await this.publications.publicScope(tx,slug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration');
      const {store}=await this.publications.publicScope(tx,slug),account=await this.session(tx,store,authorization);
      checkRateLimit(account.id,{scope:'commerce.customer-reorder',limit:20,windowMs:60000});
      const order=await tx.commerceOrder.findFirst({where:{workspaceId:store.workspaceId,storeId:store.id,customerAccountId:account.id,id}});
      if(!order)throw new AppError('COMMERCE_ORDER_NOT_FOUND','Order was not found.',404);
      const snapshot=z.object({lines:z.array(z.unknown())}).safeParse(order.snapshot);
      if(!snapshot.success)throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Historical product identities are unavailable.',422);
      return new CommerceCartService(this.db,this.publications).reorderInTransaction(tx,store,snapshot.data.lines,order.id);
    },{timeout:60000});
  }
}
