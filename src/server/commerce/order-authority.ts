import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { exact } from '../inventory/decimal';

export async function commerceOrderSource(tx: Tx,actor: Principal,id: string,inventoryKey?: string) {
  const order=await commerceOrderRead(tx,actor,id);
  if (['CANCELLED','ARCHIVED'].includes(order.status)) throw new AppError('RESERVATION_SOURCE_INVALID','Order is closed.',409);
  if (!inventoryKey) return {};
  const lines = (order.snapshot as { lines?: { inventoryKey: string;quantity: string }[] }).lines ?? [];
  const quantity = lines.filter(l => l.inventoryKey===inventoryKey).reduce((s,l) => s.plus(l.quantity),exact(0));
  if (quantity.lte(0)) throw new AppError('RESERVATION_SOURCE_INVALID','SKU is not in the Order.',422);
  return { plannedQuantity: quantity.toFixed(6) };
}

/** Historical owning reads remain available for consistency checks of terminal Orders. */
export async function commerceOrderRead(tx:Tx,actor:Principal,id:string){
  requirePermission(actor,'COMMERCE.ORDER_VIEW');
  const workspace=await tx.workspace.findFirst({where:{id:actor.workspaceId,isDeleted:false}});
  if(!workspace||(workspace.settings as {entitlements?:{commerce?:boolean}}).entitlements?.commerce===false)throw new AppError('PERMISSION_DENIED','Commerce is unavailable for this Workspace.',403);
  const order = await tx.commerceOrder.findFirst({ where: { workspaceId: actor.workspaceId,id } });
  const store = order && await tx.commerceStore.findFirst({ where: { workspaceId: actor.workspaceId,id: order.storeId } });
  if (!order || !store || !await ownerVisible(tx,actor,store.createdByUserId,'COMMERCE.ORDER_VIEW')) throw new AppError('COMMERCE_ORDER_NOT_FOUND','Order was not found.',404);
  return order;
}

export async function commerceOrderReversal(tx: Tx,actor: Principal,id: string,documentId: string) {
  await commerceOrderSource(tx,actor,id);
  if (await tx.commerceShipment.count({ where: { workspaceId: actor.workspaceId,orderId: id,inventoryDocumentId: documentId,shippedAt: { not: null } } }))
    throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Dispatched shipment stock must use the Commerce Return flow.',409);
  const lineIds=(await tx.inventoryDocumentLine.findMany({where:{workspaceId:actor.workspaceId,documentId},select:{id:true}})).map(l=>l.id);
  if(await tx.commerceReturnLine.count({where:{workspaceId:actor.workspaceId,orderId:id,inventoryDocumentLineId:{in:lineIds}}}))throw new AppError('INVENTORY_DOCUMENT_REVERSAL_BLOCKED','Commerce Return stock requires controlled reconciliation.',409);
}

/** Inventory posting validates the plan owned by a bound Commerce Return even
 * when an administrator posts directly through Inventory after approval. */
export async function commerceReturnPosting(tx:Tx,actor:Principal,documentId:string){
  const lines=await tx.inventoryDocumentLine.findMany({where:{workspaceId:actor.workspaceId,documentId}});
  const bindings=await tx.commerceReturnLine.findMany({where:{workspaceId:actor.workspaceId,inventoryDocumentLineId:{in:lines.map(l=>l.id)}}});
  if(!bindings.length)return;
  if(bindings.length!==1||lines.length!==1)throw new AppError('RETURN_INVALID_TRANSITION','Bound Return document lines are immutable.',409);
  const record=await tx.commerceReturn.findFirst({where:{workspaceId:actor.workspaceId,id:bindings[0].returnId}});
  const inspection=record?.inspectionPlan as {postings?:{returnLineId:string;plan:{documentId:string;lineId:string;quantity:string;unitCost:string;productId:string;variantId:string|null;warehouseId:string;currency:string;orderId:string}}[]}|null;
  const plan=inspection?.postings?.find(p=>p.returnLineId===bindings[0].id)?.plan,document=await tx.inventoryDocument.findUniqueOrThrow({where:{id:documentId}}),line=lines[0];
  if(!record||!['RECEIVED','INSPECTING'].includes(record.status)||!plan||plan.documentId!==documentId||plan.lineId!==line.id||!line.quantity.eq(plan.quantity)||!line.unitCost.eq(plan.unitCost)||line.productId!==plan.productId||line.variantId!==plan.variantId||line.targetLocationId||document.destinationWarehouseId!==plan.warehouseId||document.sourceWarehouseId||document.type!=='CUSTOMER_RETURN'||document.currency!==plan.currency||document.sourceEntityType!=='ORDER'||document.sourceEntityId!==plan.orderId)throw new AppError('RETURN_INVALID_TRANSITION','Return Inventory plan changed or is unavailable.',409);
}
