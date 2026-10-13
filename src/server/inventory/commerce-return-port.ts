import type { PrismaClient } from '@prisma/client';
import { AppError,isAppError } from '../errors';
import type { Principal,Tx } from '../process-platform/context';
import { InventoryDocumentService } from './document-service';
import { exact,numeric24 } from './decimal';

export type ReturnPostingPlan={documentId:string;lineId:string;productId:string;variantId:string|null;quantity:string;unitCost:string;warehouseId:string;currency:string;orderId:string};
/** Inventory owns original issue valuation, segregation and return posting. */
export class InventoryCommerceReturnPort {
  readonly documents:InventoryDocumentService;
  constructor(db:PrismaClient){this.documents=new InventoryDocumentService(db);}
  async prepare(tx:Tx,actor:Principal,input:{orderId:string;productId:string;variantId:string|null;sourceLineIds:string[];quantity:string;warehouseId:string;currency:string;disposition:'SELLABLE'|'DAMAGED'|'REPAIR'}){
    const warehouse=await this.documents.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.DOCUMENT_CREATE',true);
    if(input.disposition==='SELLABLE'?!['PHYSICAL','STORE','FULFILLMENT'].includes(warehouse.type):!['DAMAGED','RETURNS'].includes(warehouse.type))throw new AppError('RETURN_NOT_ELIGIBLE','Disposition requires the appropriate sellable or segregated Warehouse.',422);
    const sourceLines=await tx.inventoryDocumentLine.findMany({where:{workspaceId:actor.workspaceId,id:{in:input.sourceLineIds},productId:input.productId,variantId:input.variantId}});
    if(!sourceLines.length||sourceLines.length!==new Set(input.sourceLineIds).size)throw new AppError('RETURN_NOT_ELIGIBLE','Original stock issue lines are unavailable.',409);
    for(const line of sourceLines){const document=await this.documents.document(tx,actor,line.documentId,'INVENTORY.DOCUMENT_READ');if(document.type!=='SALES_ORDER'||document.status!=='PROCESSED'||document.reversedAt||document.sourceEntityType!=='ORDER'||document.sourceEntityId!==input.orderId||document.currency!==input.currency)throw new AppError('RETURN_NOT_ELIGIBLE','Original stock issue cannot support this Return.',409);}
    const movements=await tx.inventoryMovement.findMany({where:{workspaceId:actor.workspaceId,documentLineId:{in:input.sourceLineIds},type:'SALES_ORDER_OUT'}});
    const quantity=movements.reduce((sum,m)=>sum.plus(exact(m.quantityDelta).abs()),exact(0)),value=movements.reduce((sum,m)=>sum.plus(exact(m.totalCost).abs()),exact(0));
    if(quantity.lte(0)||quantity.lt(input.quantity))throw new AppError('RETURN_QUANTITY_EXCEEDED','Original stock issues do not cover this Return.',409);
    const unitCost=numeric24(value.div(quantity));
    const document=await this.documents.createInTransaction(tx,actor,{documentType:'CUSTOMER_RETURN',warehouseIds:{destination:input.warehouseId},currency:input.currency,sourceRef:{entityType:'ORDER',entityId:input.orderId}});
    const line=await this.documents.addLineInTransaction(tx,actor,document.id,{productId:input.productId,variantId:input.variantId??undefined,quantity:input.quantity,unitCost});
    return{documentId:document.id,lineId:line.id,productId:input.productId,variantId:input.variantId,quantity:input.quantity,unitCost,warehouseId:input.warehouseId,currency:input.currency,orderId:input.orderId} satisfies ReturnPostingPlan;
  }
  async process(tx:Tx,actor:Principal,plan:ReturnPostingPlan){
    const document=await this.documents.document(tx,actor,plan.documentId,'INVENTORY.DOCUMENT_PROCESS');
    const lines=await tx.inventoryDocumentLine.findMany({where:{workspaceId:actor.workspaceId,documentId:plan.documentId}}),line=lines[0];
    if(document.type!=='CUSTOMER_RETURN'||document.sourceWarehouseId||document.destinationWarehouseId!==plan.warehouseId||document.sourceEntityType!=='ORDER'||document.sourceEntityId!==plan.orderId||document.currency!==plan.currency||document.reversedAt||lines.length!==1||line.id!==plan.lineId||line.productId!==plan.productId||line.variantId!==plan.variantId||!line.quantity.eq(plan.quantity)||!line.unitCost.eq(plan.unitCost)||line.targetLocationId)throw new AppError('RETURN_INVALID_TRANSITION','Inventory Return plan changed; reconcile before inspection.',409);
    if(document.status==='PROCESSED')return true;
    if(document.status==='PENDING_APPROVAL')return false;
    try{await this.documents.processInTransaction(tx,actor,document.id,{expectedVersion:document.version.toString()},'return:'+document.id+':'+document.version);return true;}
    catch(error){if(!isAppError(error)||error.code!=='INVENTORY_APPROVAL_REQUIRED')throw error;
      await this.documents.approvalInTransaction(tx,actor,document.id,{expectedVersion:document.version.toString()},true);return false;
    }
  }
}
