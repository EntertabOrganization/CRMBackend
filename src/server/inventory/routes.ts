import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { InventoryWarehouseService } from './warehouse-service';
import { InventoryStockService } from './stock-service';
import { InventoryPolicyService } from './policy-service';
import { InventoryCostingService } from './costing-service';
import { InventoryDocumentService } from './document-service';
import { InventoryReservationService } from './reservation-service';
import { InventoryTrackingService } from './tracking-service';
import { InventoryReorderService } from './reorder-service';
import { InventoryStocktakeService } from './stocktake-service';
import { InventoryReconciliationService } from './reconciliation-service';
import { InventoryControlledJobsService } from './controlled-jobs-service';

export const inventoryWarehouses = new InventoryWarehouseService(prisma);
export const inventoryStock = new InventoryStockService(prisma,inventoryWarehouses);
export const inventoryPolicies = new InventoryPolicyService(prisma);
export const inventoryCosting = new InventoryCostingService(prisma,inventoryWarehouses);
export const inventoryDocuments = new InventoryDocumentService(prisma,inventoryWarehouses);
export const inventoryReservations = new InventoryReservationService(prisma,inventoryWarehouses,inventoryDocuments.sources);
inventoryDocuments.setReservationPort(inventoryReservations);
inventoryReservations.setDocumentAuthority(inventoryDocuments);
export const inventoryTracking = new InventoryTrackingService(prisma,inventoryWarehouses,inventoryDocuments);
export const inventoryReorder = new InventoryReorderService(prisma,inventoryWarehouses);
export const inventoryStocktakes = new InventoryStocktakeService(prisma,inventoryWarehouses,inventoryDocuments);
inventoryDocuments.setStocktakePort(inventoryStocktakes);
export const inventoryReconciliation = new InventoryReconciliationService(prisma,inventoryWarehouses);
export const inventoryControlledJobs = new InventoryControlledJobsService(prisma,inventoryWarehouses,inventoryDocuments);
export const inventoryRouter = new PackRouter()
  .add('POST','/api/v1/inventory/warehouses','WarehousesController',c => inventoryWarehouses.create(c.actor,c.body),201)
  .add('GET','/api/v1/inventory/warehouses','WarehousesController',c => inventoryWarehouses.list(c.actor,c.query))
  .add('GET','/api/v1/inventory/warehouses/:warehouseId','WarehousesController',c => inventoryWarehouses.get(c.actor,c.params.warehouseId))
  .add('PATCH','/api/v1/inventory/warehouses/:warehouseId','WarehousesController',c => inventoryWarehouses.update(c.actor,c.params.warehouseId,c.body))
  .add('POST','/api/v1/inventory/warehouses/:warehouseId/archive','WarehousesController',c => inventoryWarehouses.update(c.actor,c.params.warehouseId,c.body,true))
  .add('GET','/api/v1/inventory/warehouses/:warehouseId/locations','WarehouseLocationsController',c => inventoryWarehouses.locations(c.actor,c.params.warehouseId,c.query))
  .add('POST','/api/v1/inventory/warehouses/:warehouseId/locations','WarehouseLocationsController',c => inventoryWarehouses.changeLocation(c.actor,c.params.warehouseId,c.body),201)
  .add('PATCH','/api/v1/inventory/warehouses/:warehouseId/locations/:locationId','WarehouseLocationsController',c => inventoryWarehouses.changeLocation(c.actor,c.params.warehouseId,c.body,c.params.locationId))
  .add('GET','/api/v1/inventory/warehouses/:warehouseId/permissions','WarehousesController',c => inventoryWarehouses.permissions(c.actor,c.params.warehouseId))
  .add('PUT','/api/v1/inventory/warehouses/:warehouseId/permissions','WarehousesController',c => inventoryWarehouses.permissions(c.actor,c.params.warehouseId,c.body))
  .add('GET','/api/v1/inventory/stock','InventoryStockController',c => inventoryStock.list(c.actor,c.query))
  .add('POST','/api/v1/inventory/stock/reconciliation-jobs','InventoryStockController',c => inventoryReconciliation.create(c.actor,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/inventory/stock/reconciliation-jobs/:jobId','InventoryStockController',c => inventoryReconciliation.get(c.actor,c.params.jobId))
  .add('GET','/api/v1/inventory/availability','InventoryStockController',c => inventoryStock.availability(c.actor,c.query))
  .add('GET','/api/v1/inventory/movements','InventoryMovementsController',c => inventoryStock.movements(c.actor,c.query))
  .add('GET','/api/v1/inventory/movements/:movementId','InventoryMovementsController',c => inventoryStock.movements(c.actor,{},c.params.movementId))
  .add('GET','/api/v1/inventory/settings','InventoryPoliciesController',c => inventoryPolicies.get(c.actor))
  .add('PATCH','/api/v1/inventory/settings','InventoryPoliciesController',c => inventoryPolicies.update(c.actor,c.body))
  .add('GET','/api/v1/inventory/document-policies/:documentType','InventoryPoliciesController',c => inventoryPolicies.documentPolicy(c.actor,c.params.documentType))
  .add('PUT','/api/v1/inventory/document-policies/:documentType','InventoryPoliciesController',c => inventoryPolicies.documentPolicy(c.actor,c.params.documentType,c.body))
  .add('PUT','/api/v1/inventory/numbering/:documentType','InventoryReorderController',c => inventoryPolicies.numbering(c.actor,c.params.documentType,c.body))
  .add('GET','/api/v1/inventory/costing/policy','InventoryCostingController',c => inventoryCosting.policy(c.actor))
  .add('POST','/api/v1/inventory/costing/initialize','InventoryCostingController',c => inventoryCosting.initialize(c.actor,c.body))
  .add('GET','/api/v1/inventory/valuation','InventoryCostingController',c => inventoryCosting.valuation(c.actor,c.query))
  .add('POST','/api/v1/inventory/costing/migration-preview','InventoryCostingController',c => inventoryControlledJobs.preview(c.actor,c.body),202)
  .add('POST','/api/v1/inventory/costing/migrate','InventoryCostingController',c => inventoryControlledJobs.apply(c.actor,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/inventory/costing/migrations/:jobId','InventoryCostingController',c => inventoryControlledJobs.get(c.actor,c.params.jobId,true))
  .add('POST','/api/v1/inventory/reset/preview','InventoryPoliciesController',c => inventoryControlledJobs.preview(c.actor,c.body,true),202)
  .add('POST','/api/v1/inventory/reset/apply','InventoryPoliciesController',c => inventoryControlledJobs.apply(c.actor,c.body,c.request.headers.get('idempotency-key'),true),202)
  .add('GET','/api/v1/inventory/jobs/:jobId','InventoryPoliciesController',c => inventoryControlledJobs.get(c.actor,c.params.jobId))
  .add('POST','/api/v1/inventory/jobs/:jobId/approve','InventoryPoliciesController',c => inventoryControlledJobs.approve(c.actor,c.params.jobId,c.body))
  .add('POST','/api/v1/inventory/jobs/:jobId/resume','InventoryPoliciesController',c => inventoryControlledJobs.resume(c.actor,c.params.jobId,c.body),202)
  .add('POST','/api/v1/inventory/documents','InventoryDocumentsController',c => inventoryDocuments.create(c.actor,c.body),201)
  .add('GET','/api/v1/inventory/documents','InventoryDocumentsController',c => inventoryDocuments.list(c.actor,c.query))
  .add('GET','/api/v1/inventory/documents/:documentId','InventoryDocumentsController',c => inventoryDocuments.get(c.actor,c.params.documentId))
  .add('PATCH','/api/v1/inventory/documents/:documentId','InventoryDocumentsController',c => inventoryDocuments.update(c.actor,c.params.documentId,c.body))
  .add('POST','/api/v1/inventory/documents/:documentId/lines','InventoryDocumentLinesController',c => inventoryDocuments.line(c.actor,c.params.documentId,c.body),201)
  .add('PATCH','/api/v1/inventory/documents/:documentId/lines/:lineId','InventoryDocumentLinesController',c => inventoryDocuments.line(c.actor,c.params.documentId,c.body,c.params.lineId))
  .add('DELETE','/api/v1/inventory/documents/:documentId/lines/:lineId','InventoryDocumentLinesController',c => inventoryDocuments.line(c.actor,c.params.documentId,c.body,c.params.lineId,true))
  .add('POST','/api/v1/inventory/documents/:documentId/request-approval','InventoryDocumentsController',c => inventoryDocuments.approval(c.actor,c.params.documentId,c.body,true))
  .add('POST','/api/v1/inventory/documents/:documentId/approve','InventoryDocumentsController',c => inventoryDocuments.approval(c.actor,c.params.documentId,c.body))
  .add('POST','/api/v1/inventory/documents/:documentId/process','InventoryDocumentsController',c => inventoryDocuments.process(c.actor,c.params.documentId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/inventory/documents/:documentId/reverse','InventoryDocumentsController',c => inventoryDocuments.reverse(c.actor,c.params.documentId,c.body,c.request.headers.get('idempotency-key')))
  .add('GET','/api/v1/inventory/documents/:documentId/history','InventoryDocumentsController',c => inventoryDocuments.historyList(c.actor,c.params.documentId,c.query))
  .add('POST','/api/v1/inventory/reservations','InventoryReservationsController',c => inventoryReservations.create(c.actor,c.body,c.request.headers.get('idempotency-key')),201)
  .add('GET','/api/v1/inventory/reservations','InventoryReservationsController',c => inventoryReservations.list(c.actor,c.query))
  .add('GET','/api/v1/inventory/reservations/:reservationId','InventoryReservationsController',c => inventoryReservations.get(c.actor,c.params.reservationId))
  .add('PATCH','/api/v1/inventory/reservations/:reservationId','InventoryReservationsController',c => inventoryReservations.update(c.actor,c.params.reservationId,c.body))
  .add('POST','/api/v1/inventory/reservations/:reservationId/release','InventoryReservationsController',c => inventoryReservations.release(c.actor,c.params.reservationId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/inventory/reservations/:reservationId/fulfill','InventoryReservationsController',c => inventoryReservations.fulfill(c.actor,c.params.reservationId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/inventory/reservations/:reservationId/extend','InventoryReservationsController',c => inventoryReservations.update(c.actor,c.params.reservationId,c.body,true))
  .add('GET','/api/v1/inventory/barcodes/resolve','InventoryTrackingController',c => inventoryTracking.resolve(c.actor,c.query))
  .add('POST','/api/v1/inventory/barcodes','InventoryTrackingController',c => inventoryTracking.barcode(c.actor,c.body),201)
  .add('DELETE','/api/v1/inventory/barcodes/:barcodeId','InventoryTrackingController',c => inventoryTracking.barcode(c.actor,c.body,c.params.barcodeId))
  .add('GET','/api/v1/inventory/serials','InventoryTrackingController',c => inventoryTracking.serials(c.actor,c.query))
  .add('POST','/api/v1/inventory/serials','InventoryTrackingController',c => inventoryTracking.serial(c.actor,c.body),201)
  .add('GET','/api/v1/inventory/batches','InventoryTrackingController',c => inventoryTracking.batches(c.actor,c.query))
  .add('POST','/api/v1/inventory/batches','InventoryTrackingController',c => inventoryTracking.batch(c.actor,c.body),201)
  .add('GET','/api/v1/inventory/reorder-rules','InventoryReorderController',c => inventoryReorder.list(c.actor,c.query))
  .add('PUT','/api/v1/inventory/reorder-rules/:ruleId','InventoryReorderController',c => inventoryReorder.upsert(c.actor,c.params.ruleId,c.body))
  .add('GET','/api/v1/inventory/low-stock-alerts','InventoryReorderController',c => inventoryReorder.list(c.actor,c.query,true))
  .add('POST','/api/v1/inventory/stocktakes','InventoryStocktakesController',c => inventoryStocktakes.create(c.actor,c.body),201)
  .add('GET','/api/v1/inventory/stocktakes','InventoryStocktakesController',c => inventoryStocktakes.list(c.actor,c.query))
  .add('GET','/api/v1/inventory/stocktakes/:sessionId','InventoryStocktakesController',c => inventoryStocktakes.get(c.actor,c.params.sessionId))
  .add('POST','/api/v1/inventory/stocktakes/:sessionId/start','InventoryStocktakesController',c => inventoryStocktakes.start(c.actor,c.params.sessionId,c.body))
  .add('PUT','/api/v1/inventory/stocktakes/:sessionId/lines/:lineId/count','InventoryStocktakesController',c => inventoryStocktakes.count(c.actor,c.params.sessionId,c.params.lineId,c.body))
  .add('POST','/api/v1/inventory/stocktakes/:sessionId/reconcile','InventoryStocktakesController',c => inventoryStocktakes.reconcile(c.actor,c.params.sessionId,c.body))
  .add('POST','/api/v1/inventory/stocktakes/:sessionId/post','InventoryStocktakesController',c => inventoryStocktakes.post(c.actor,c.params.sessionId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/inventory/stocktakes/:sessionId/cancel','InventoryStocktakesController',c => inventoryStocktakes.cancel(c.actor,c.params.sessionId,c.body));
