import { PrismaClient,Prisma } from '@prisma/client';
import { createHash,randomUUID } from 'node:crypto';
import { resolvePrincipal } from '../../src/server/process-platform/context';
import { PaymentProviderAuthority } from '../../src/server/commercial/payment-provider-authority';
import { DeterministicLifecyclePaymentAdapter } from '../../src/server/commercial/payment-providers';
import { CommercePaymentCommandService } from '../../src/server/commerce/payment-command-service';
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
export async function paymentCommandFixture(db:PrismaClient,snapshot:Prisma.InputJsonValue={}){
 const user=await db.user.create({data:{firstName:'Payment',lastName:'Command',email:randomUUID()+'@example.test',status:'ACTIVE'}});
 const workspace=await db.workspace.create({data:{name:'Commands',slug:randomUUID(),ownerUserId:user.id}}),role=await db.role.create({data:{workspaceId:workspace.id,name:'Operator',isOwnerRole:true}});
 await db.workspaceMembership.create({data:{workspaceId:workspace.id,userId:user.id,roleId:role.id}});
 await db.rolePermission.createMany({data:(await db.permission.findMany()).map(p=>({roleId:role.id,permissionId:p.id,scope:'WORKSPACE' as const}))});
 const actor=await resolvePrincipal(db,workspace.id,user.id),catalog=await db.catalog.create({data:{workspaceId:workspace.id,name:'Catalog',normalizedName:'catalog'}});
 const connection=await db.integrationOutboundConnection.create({data:{workspaceId:workspace.id,name:'Payments',baseUrl:'https://api.stripe.com/',allowedHosts:['api.stripe.com'],secretReference:'test-payment-bundle',supportsIdempotency:true,createdByUserId:user.id}});
 const method={id:randomUUID(),provider:'stripe' as const,connectionId:connection.id,modes:['SALE','AUTHORIZE'],multicapture:true};
 const store=await db.commerceStore.create({data:{workspaceId:workspace.id,name:'Store',code:'COMMANDS',status:'ACTIVE',catalogId:catalog.id,defaultCurrency:'EGP',timezone:'Africa/Cairo',createdByUserId:user.id,settings:{paymentMethods:['OFFLINE'],deliveryPolicy:'PICKUP',paymentPrincipalUserId:user.id,providerPaymentMethods:[method]}}});
 const cart=await db.commerceCart.create({data:{workspaceId:workspace.id,storeId:store.id,tokenHash:hash(),currency:'EGP',expiresAt:new Date(Date.now()+3600000)}});
 const session=await db.commerceCheckoutSession.create({data:{workspaceId:workspace.id,storeId:store.id,cartId:cart.id,tokenHash:hash(),customerSnapshot:{},addressSnapshot:{},payerType:'PERSON',expiresAt:new Date(Date.now()+3600000)}});
 const order=await db.commerceOrder.create({data:{workspaceId:workspace.id,storeId:store.id,cartId:cart.id,checkoutSessionId:session.id,currency:'EGP',total:'100',snapshot,consents:[]}});
 const provider=new DeterministicLifecyclePaymentAdapter('stripe','test-only-webhook-secret','merchant-test');
 const secrets=new Map([['test-payment-bundle',JSON.stringify({apiKey:'test-only-api-key-marker',webhookSecret:'test-only-webhook-marker',merchantId:'merchant-test'})]]);
 const authority=new PaymentProviderAuthority({resolve:(ws,ref)=>ws===workspace.id?secrets.get(ref)??null:null},()=>provider),service=new CommercePaymentCommandService(db,undefined,authority);
 return{user,workspace,role,actor,connection,method,store,order,provider,secrets,authority,service};
}
