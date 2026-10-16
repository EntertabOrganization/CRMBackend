import { prisma } from '../prisma-client';
import { SpaMigrationService } from '../spa/migration-service';
import { SpaRecurrenceService } from '../spa/recurrence-service';
import { SpaTransferService } from '../spa/transfer-service';
import { WorkflowRuntime } from '../workflows/runtime';
import { WorkflowWaitWorker } from '../workflows/wait-worker';
import { WorkflowTriggerWorker } from '../workflows/trigger-worker';
import { WorkflowCompensationService } from '../workflows/compensation-service';
import { WorkflowGovernanceService } from '../workflows/governance-service';
import { InventoryReservationService } from '../inventory/reservation-service';
import { CommerceCartWorker } from '../commerce/cart-worker';
import { CommerceDeliveryCallbackService } from '../commerce/delivery-callback-service';
import { CommercePaymentCommandService } from '../commerce/payment-command-service';
import { CommercePaymentCallbackService } from '../commerce/payment-callback-service';
import { CommerceReconciliationService } from '../commerce/reconciliation-service';
import { CommerceCrmSyncService } from '../commerce/crm-sync-service';
import { CommercePaidReservationService } from '../commerce/paid-reservation-service';
import { CommerceRefundService } from '../commerce/refund-service';
import { InventoryReconciliationService } from '../inventory/reconciliation-service';
import { InventoryControlledJobsService } from '../inventory/controlled-jobs-service';
import { SuiteWorkers } from '../suite/workers';

/** A separate worker process may scale independently; domain DB locks/leases fence competing processes. */
export class ProcessPlatformWorkers {
  private stopped = false;
  private readonly migrations = new SpaMigrationService(prisma);
  private readonly recurrence = new SpaRecurrenceService(prisma);
  private readonly transfers = new SpaTransferService(prisma);
  private readonly workflowRuntime = new WorkflowRuntime(prisma);
  private readonly workflowWaits = new WorkflowWaitWorker(prisma,this.workflowRuntime);
  private readonly workflowTriggers = new WorkflowTriggerWorker(prisma,this.workflowRuntime);
  private readonly workflowCompensations = new WorkflowCompensationService(prisma,this.workflowRuntime.executions);
  private readonly workflowGovernance = new WorkflowGovernanceService(prisma,this.workflowRuntime.executions);
  private readonly inventoryReservations = new InventoryReservationService(prisma);
  private readonly commerceCarts = new CommerceCartWorker(prisma);
  private readonly commerceDelivery = new CommerceDeliveryCallbackService(prisma);
  private readonly commercePayments = new CommercePaymentCommandService(prisma);
  private readonly commercePaymentCallbacks = new CommercePaymentCallbackService(prisma);
  private readonly commerceReconciliation = new CommerceReconciliationService(prisma);
  private readonly commerceCrmSync = new CommerceCrmSyncService(prisma);
  private readonly commercePaidReservations = new CommercePaidReservationService(prisma);
  private readonly commerceRefunds = new CommerceRefundService(prisma);
  private readonly inventoryReconciliation = new InventoryReconciliationService(prisma);
  private readonly inventoryControlledJobs = new InventoryControlledJobsService(prisma);
  private readonly suite = new SuiteWorkers(prisma);
  stop() { this.stopped = true; }
  async tick() {
    const migrations = await this.migrations.runDue(10);
    const recurrence = await this.recurrence.runDue(10);
    const transfers = await this.transfers.runTransfers(5);
    const purges = await this.transfers.runPurges(10);
    const workflowDispatch = await this.workflowRuntime.tick(20);
    const workflowWaits = await this.workflowWaits.tick(20);
    const workflowEvents = await this.workflowTriggers.events(20);
    const workflowSchedules = await this.workflowTriggers.schedules(10);
    const workflowCallbacks = await this.workflowRuntime.callbacks.tick(20);
    const workflowCompensations = await this.workflowCompensations.tick(20);
    const workflowReconciliation = await this.workflowGovernance.tick(10);
    const workflowRetention = await this.workflowGovernance.purgeRetention(50);
    const inventoryExpiry = await this.inventoryReservations.expireDue(50);
    const commerceCarts = await this.commerceCarts.tick(50);
    const commerceDelivery = await this.commerceDelivery.tick(20);
    const commercePayments = await this.commercePayments.tick(20);
    const commerceRefunds = await this.commerceRefunds.tick(20);
    const commercePaymentCallbacks = await this.commercePaymentCallbacks.tick(20);
    const commerceReconciliation = await this.commerceReconciliation.tick(10);
    const commerceCrmSync = await this.commerceCrmSync.tick(10);
    const commercePaidReservations = await this.commercePaidReservations.tick(10);
    const inventoryReconciliation = await this.inventoryReconciliation.tick(5);
    const inventoryControlledJobs = await this.inventoryControlledJobs.tick(5);
    const businessSuite = await this.suite.tick();
    return { migrations, recurrence, transfers, purges, workflowDispatch, workflowWaits,workflowEvents,workflowSchedules,workflowCallbacks,workflowCompensations,workflowReconciliation,workflowRetention,inventoryExpiry,commerceCarts,commerceDelivery,commercePayments,commerceRefunds,commercePaymentCallbacks,commerceReconciliation,commerceCrmSync,commercePaidReservations,inventoryReconciliation,inventoryControlledJobs,businessSuite };
  }
  async run() {
    while (!this.stopped) {
      try { await this.tick(); }
      catch { process.stderr.write('Process platform worker cycle failed; retrying.\n'); }
      if (!this.stopped) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/process-platform/workers.ts')) {
  const host = new ProcessPlatformWorkers();
  process.once('SIGINT', () => host.stop());
  process.once('SIGTERM', () => host.stop());
  host.run().finally(() => prisma.$disconnect()).catch(() => { process.exitCode = 1; });
}
