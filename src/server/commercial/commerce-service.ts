import type { ActorContext } from "../access-service";
import {
  calculateRow,
  fitsCurrency,
  fromScaled,
  isValidCurrency,
  sumScaled,
  toScaled,
} from "../catalog/money";
import { AppError, badRequest, conflict } from "../errors";
import type { InMemoryStore } from "../store";
import type {
  Estimate,
  EstimateRevision,
  EstimateStage,
  EstimateStatus,
  Invoice,
  MoneyLine,
  Payment,
  RecurringRule,
} from "./types";
import { CommercialSupport, stableHash } from "./support";
import type { RequisiteService } from "./requisite-service";
import type {
  PaymentProviderRegistry,
  VerifiedProviderEvent,
} from "./payment-providers";

type Access = {
  requireScope(actor: ActorContext, key: string): unknown;
  crmRecord(workspaceId: string, type: string, id: string): any;
  isActiveMember(workspaceId: string, userId: string): boolean;
};
type LineInput = {
  productId?: string | null;
  description: string;
  quantity: string | number;
  unitCode?: string | null;
  unitPrice: string | number;
  discountType?: "NONE" | "PERCENT" | "FIXED";
  discountValue?: string | number;
  taxCode?: string | null;
  taxRate?: string | number;
  sortOrder?: number;
};
type PartyInput = {
  ownerType: "CONTACT" | "COMPANY";
  ownerId: string;
  requisiteId: string;
  addressId?: string | null;
  bankAccountId?: string | null;
};

export class CommerceService {
  readonly support: CommercialSupport;
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: Access,
    private readonly requisites: RequisiteService,
    readonly providers: PaymentProviderRegistry,
  ) {
    this.support = new CommercialSupport(store, access);
  }

  listEstimateStages(actor: ActorContext) {
    this.support.require(actor, "estimate.read");
    this.ensureEstimateStages(actor.workspaceId);
    return this.store.state.estimateStages
      .filter((x) => x.workspaceId === actor.workspaceId)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  createEstimateStage(
    actor: ActorContext,
    input: {
      name: string;
      semanticStatus: EstimateStatus;
      position?: number;
      isDefault?: boolean;
    },
  ) {
    if (this.access.requireScope(actor, "estimate.update") !== "WORKSPACE")
      throw new AppError(
        "PERMISSION_DENIED",
        "Estimate stage configuration requires workspace scope.",
        403,
      );
    if (
      ![
        "DRAFT",
        "ACTIVE",
        "ACCEPTED",
        "DECLINED",
        "EXPIRED",
        "CONVERTED",
      ].includes(input.semanticStatus)
    )
      throw badRequest(
        "ESTIMATE_STAGE_INVALID",
        "Estimate semantic status is invalid.",
      );
    this.ensureEstimateStages(actor.workspaceId);
    if (input.isDefault)
      this.store.state.estimateStages
        .filter((x) => x.workspaceId === actor.workspaceId)
        .forEach((x) => (x.isDefault = false));
    const row: EstimateStage = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      name: this.support.text(input.name, "name"),
      semanticStatus: input.semanticStatus,
      position:
        input.position ??
        this.store.state.estimateStages.filter(
          (x) => x.workspaceId === actor.workspaceId,
        ).length,
      active: true,
      isDefault: Boolean(input.isDefault),
      version: 1,
    };
    this.store.state.estimateStages.push(row);
    this.support.audit(
      actor,
      "ESTIMATE_STAGE.CREATED",
      "EstimateStage",
      row.id,
      null,
      row,
    );
    return row;
  }
  updateEstimateStage(
    actor: ActorContext,
    id: string,
    input: Partial<
      Pick<EstimateStage, "name" | "position" | "active" | "isDefault">
    >,
  ) {
    if (this.access.requireScope(actor, "estimate.update") !== "WORKSPACE")
      throw new AppError(
        "PERMISSION_DENIED",
        "Estimate stage configuration requires workspace scope.",
        403,
      );
    const stage = this.store.state.estimateStages.find(
      (x) => x.id === id && x.workspaceId === actor.workspaceId,
    );
    if (!stage)
      throw new AppError(
        "ESTIMATE_STAGE_INVALID",
        "Estimate stage was not found.",
        404,
      );
    if (input.name !== undefined)
      stage.name = this.support.text(input.name, "name");
    if (input.position !== undefined) {
      if (!Number.isInteger(input.position) || input.position < 0)
        throw badRequest(
          "ESTIMATE_STAGE_INVALID",
          "Stage position is invalid.",
        );
      stage.position = input.position;
    }
    if (input.active !== undefined) {
      if (
        !input.active &&
        this.store.state.estimates.some(
          (x) =>
            x.workspaceId === actor.workspaceId &&
            x.stageId === stage.id &&
            !x.archived,
        )
      )
        throw conflict(
          "ESTIMATE_STAGE_INVALID",
          "A stage used by active Estimates cannot be disabled.",
        );
      stage.active = input.active;
    }
    if (input.isDefault) {
      this.store.state.estimateStages
        .filter((x) => x.workspaceId === actor.workspaceId)
        .forEach((x) => (x.isDefault = false));
      stage.isDefault = true;
    }
    stage.version++;
    this.support.audit(
      actor,
      "ESTIMATE_STAGE.UPDATED",
      "EstimateStage",
      stage.id,
      null,
      input,
    );
    return stage;
  }

  createEstimate(
    actor: ActorContext,
    input: {
      subject: string;
      stageId: string;
      sellerCompanyId?: string;
      customerContactId?: string | null;
      customerCompanyId?: string | null;
      dealId?: string | null;
      currencyCode: string;
      validUntil?: string | null;
      responsibleUserId?: string | null;
      lines: LineInput[];
    },
  ) {
    this.support.require(actor, "estimate.create");
    if (
      input.responsibleUserId &&
      !this.access.isActiveMember(actor.workspaceId, input.responsibleUserId)
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Responsible user is not an active workspace member.",
        404,
      );
    if (
      input.dealId &&
      !this.access.crmRecord(actor.workspaceId, "DEAL", input.dealId)
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Deal was not found in this workspace.",
        404,
      );
    if (input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil))
      throw badRequest(
        "ESTIMATE_REQUIRED_DATA_MISSING",
        "validUntil must be a date.",
      );
    const stage = this.resolveEstimateStage(actor.workspaceId, input.stageId);
    if (!["DRAFT", "ACTIVE"].includes(stage.semanticStatus))
      throw badRequest(
        "ESTIMATE_STAGE_INVALID",
        "New Estimate must begin in a draft or active stage.",
      );
    const seller = this.requisites.resolveSeller(
      actor.workspaceId,
      null,
      input.sellerCompanyId,
    );
    this.validateCustomer(
      actor.workspaceId,
      input.customerContactId,
      input.customerCompanyId,
    );
    const lines = this.lines(
      actor.workspaceId,
      input.currencyCode,
      input.lines,
    );
    const totals = this.totals(lines);
    const revision: EstimateRevision = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      estimateId: "",
      revisionNumber: 1,
      status: "DRAFT",
      currencyCode: input.currencyCode.toUpperCase(),
      ...totals,
      lines,
    };
    const row: Estimate = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      number: null,
      subject: this.support.text(input.subject, "subject"),
      semanticStatus: stage.semanticStatus,
      stageId: stage.id,
      customerContactId: input.customerContactId ?? null,
      customerCompanyId: input.customerCompanyId ?? null,
      dealId: input.dealId ?? null,
      sellerCompanyId: seller.companyId,
      currencyCode: input.currencyCode.toUpperCase(),
      currentRevisionNumber: 1,
      acceptedRevisionNumber: null,
      validUntil: input.validUntil ?? null,
      responsibleUserId: input.responsibleUserId ?? actor.user.id,
      sourceFormSubmissionId: null,
      archived: false,
      version: 1,
      revisions: [revision],
    };
    revision.estimateId = row.id;
    this.store.state.estimates.push(row);
    this.support.audit(actor, "ESTIMATE.CREATED", "Estimate", row.id, null, {
      subject: row.subject,
      total: totals.grandTotal,
    });
    this.support.event(actor, "ESTIMATE_CREATED", "ESTIMATE", row.id, {
      revisionNumber: 1,
    });
    return row;
  }
  getEstimate(actor: ActorContext, id: string) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.read", e.responsibleUserId);
    return e;
  }
  listEstimates(actor: ActorContext) {
    return this.store.state.estimates.filter(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        this.support.canReadRecord(actor, "estimate.read", x.responsibleUserId),
    );
  }
  updateEstimate(
    actor: ActorContext,
    id: string,
    input: {
      subject?: string;
      stageId?: string;
      validUntil?: string | null;
      lines?: LineInput[];
    },
  ) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.update", e.responsibleUserId);
    let rev = this.currentRevision(e);
    if (rev.status !== "DRAFT") {
      rev = {
        ...structuredClone(rev),
        id: this.store.id(),
        revisionNumber: e.currentRevisionNumber + 1,
        status: "DRAFT",
        sentAt: null,
        acceptedAt: null,
        declinedAt: null,
        buyerSnapshotId: null,
        sellerSnapshotId: null,
      };
      e.revisions.push(rev);
      e.currentRevisionNumber = rev.revisionNumber;
      this.support.event(actor, "ESTIMATE_REVISION_CREATED", "ESTIMATE", e.id, {
        revisionNumber: rev.revisionNumber,
      });
    }
    if (input.subject) e.subject = this.support.text(input.subject, "subject");
    if (input.validUntil !== undefined) {
      if (input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil))
        throw badRequest(
          "ESTIMATE_REQUIRED_DATA_MISSING",
          "validUntil must be a date.",
        );
      e.validUntil = input.validUntil;
    }
    if (input.stageId) {
      const stage = this.resolveEstimateStage(actor.workspaceId, input.stageId);
      if (
        !["DRAFT", "ACTIVE"].includes(stage.semanticStatus) ||
        ["ACCEPTED", "DECLINED", "EXPIRED", "CONVERTED"].includes(
          e.semanticStatus,
        )
      )
        throw conflict(
          "ESTIMATE_STATE_INVALID",
          "Estimate cannot transition to the requested stage.",
        );
      e.stageId = stage.id;
      e.semanticStatus = stage.semanticStatus;
    }
    if (input.lines) {
      rev.lines = this.lines(actor.workspaceId, e.currencyCode, input.lines);
      Object.assign(rev, this.totals(rev.lines));
    }
    e.version++;
    this.support.audit(actor, "ESTIMATE.UPDATED", "Estimate", e.id, null, {
      version: e.version,
      revisionNumber: rev.revisionNumber,
    });
    this.support.event(actor, "ESTIMATE_UPDATED", "ESTIMATE", e.id, {
      version: e.version,
    });
    return e;
  }
  expireDueEstimates(now = new Date()) {
    const today = now.toISOString().slice(0, 10),
      expired: Estimate[] = [];
    for (const estimate of this.store.state.estimates) {
      if (
        !estimate.validUntil ||
        estimate.validUntil >= today ||
        !["DRAFT", "ACTIVE"].includes(estimate.semanticStatus)
      )
        continue;
      const revision = this.currentRevision(estimate);
      if (revision.status === "SENT" || revision.status === "DRAFT")
        revision.status = "EXPIRED";
      this.setEstimateSemantic(estimate, "EXPIRED");
      estimate.version++;
      this.support.serviceEvent(
        estimate.workspaceId,
        "ESTIMATE_EXPIRED",
        "ESTIMATE",
        estimate.id,
        { validUntil: estimate.validUntil },
        `${estimate.id}:${estimate.validUntil}`,
      );
      expired.push(estimate);
    }
    return expired;
  }
  sendEstimate(
    actor: ActorContext,
    id: string,
    parties: { buyer: PartyInput; seller: PartyInput },
  ) {
    return this.store.atomicSync(() => {
      const e = this.estimate(actor.workspaceId, id);
      this.support.requireRecord(actor, "estimate.send", e.responsibleUserId);
      const rev = this.currentRevision(e);
      if (
        rev.status !== "DRAFT" ||
        !["DRAFT", "ACTIVE"].includes(e.semanticStatus)
      )
        throw conflict(
          "ESTIMATE_STATE_INVALID",
          "Only a draft/active Estimate revision can be sent.",
        );
      const buyer = this.requisites.createSnapshot(
        actor,
        "BUYER",
        parties.buyer,
      );
      const seller = this.requisites.createSnapshot(
        actor,
        "SELLER",
        parties.seller,
      );
      rev.buyerSnapshotId = buyer.id;
      rev.sellerSnapshotId = seller.id;
      rev.status = "SENT";
      rev.sentAt = new Date();
      this.setEstimateSemantic(e, "ACTIVE");
      this.support.audit(actor, "ESTIMATE.SENT", "Estimate", e.id, null, {
        revisionNumber: rev.revisionNumber,
        total: rev.grandTotal,
      });
      this.support.event(actor, "ESTIMATE_SENT", "ESTIMATE", e.id, {
        revisionNumber: rev.revisionNumber,
        total: rev.grandTotal,
      });
      return e;
    });
  }
  acceptEstimate(actor: ActorContext, id: string, revisionNumber: number) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.accept", e.responsibleUserId);
    const r = e.revisions.find((x) => x.revisionNumber === revisionNumber);
    if (!r || r !== this.currentRevision(e))
      throw conflict(
        "ESTIMATE_REVISION_NOT_CURRENT",
        "Estimate revision is not current.",
      );
    if (r.status !== "SENT")
      throw conflict(
        "ESTIMATE_STATE_INVALID",
        "Only a sent revision can be accepted.",
      );
    r.status = "ACCEPTED";
    r.acceptedAt = new Date();
    e.acceptedRevisionNumber = revisionNumber;
    this.setEstimateSemantic(e, "ACCEPTED");
    this.support.audit(actor, "ESTIMATE.ACCEPTED", "Estimate", e.id, null, {
      revisionNumber,
    });
    this.support.event(actor, "ESTIMATE_ACCEPTED", "ESTIMATE", e.id, {
      revisionNumber,
    });
    return e;
  }
  declineEstimate(actor: ActorContext, id: string, revisionNumber: number) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.decline", e.responsibleUserId);
    const r = e.revisions.find((x) => x.revisionNumber === revisionNumber);
    if (!r || r !== this.currentRevision(e))
      throw conflict(
        "ESTIMATE_REVISION_NOT_CURRENT",
        "Estimate revision is not current.",
      );
    if (r.status !== "SENT")
      throw conflict(
        "ESTIMATE_STATE_INVALID",
        "Only a sent revision can be declined.",
      );
    r.status = "DECLINED";
    r.declinedAt = new Date();
    this.setEstimateSemantic(e, "DECLINED");
    this.support.audit(actor, "ESTIMATE.DECLINED", "Estimate", e.id, null, {
      revisionNumber,
    });
    this.support.event(actor, "ESTIMATE_DECLINED", "ESTIMATE", e.id, {
      revisionNumber,
    });
    return e;
  }
  archiveEstimate(actor: ActorContext, id: string) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.archive", e.responsibleUserId);
    e.archived = true;
    this.support.audit(actor, "ESTIMATE.ARCHIVED", "Estimate", e.id);
    this.support.event(actor, "ESTIMATE_ARCHIVED", "ESTIMATE", e.id);
    return e;
  }
  restoreEstimate(actor: ActorContext, id: string) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.restore", e.responsibleUserId);
    e.archived = false;
    this.support.audit(actor, "ESTIMATE.RESTORED", "Estimate", e.id);
    this.support.event(actor, "ESTIMATE_RESTORED", "ESTIMATE", e.id);
    return e;
  }
  convertEstimate(
    actor: ActorContext,
    id: string,
    input: { idempotencyKey: string; dueDate?: string | null },
  ) {
    const e = this.estimate(actor.workspaceId, id);
    this.support.requireRecord(actor, "estimate.convert", e.responsibleUserId);
    this.support.require(actor, "invoice.create");
    if (!e.acceptedRevisionNumber)
      throw conflict("ESTIMATE_STATE_INVALID", "Estimate must be accepted.");
    const operation = `estimate.convert:${e.id}`;
    const existing = this.idempotent(
      actor,
      operation,
      input.idempotencyKey,
      input,
    );
    if (existing)
      return this.invoice(actor.workspaceId, String(existing.invoiceId));
    const r = e.revisions.find(
      (x) => x.revisionNumber === e.acceptedRevisionNumber,
    )!;
    const invoice = this.createInvoiceInternal(actor, {
      sellerCompanyId: e.sellerCompanyId,
      customerContactId: e.customerContactId,
      customerCompanyId: e.customerCompanyId,
      currencyCode: e.currencyCode,
      lines: r.lines.map((x) => ({ ...x })),
      dueDate: input.dueDate ?? null,
      sourceEstimateId: e.id,
      sourceEstimateRevisionId: r.id,
      dealId: e.dealId,
    });
    this.setEstimateSemantic(e, "CONVERTED");
    this.remember(actor, operation, input.idempotencyKey, input, {
      invoiceId: invoice.id,
    });
    this.support.audit(
      actor,
      "ESTIMATE.INVOICE_CREATED",
      "Estimate",
      e.id,
      null,
      { revisionNumber: r.revisionNumber, invoiceId: invoice.id },
    );
    this.support.event(
      actor,
      "ESTIMATE_INVOICE_CREATED",
      "ESTIMATE",
      e.id,
      { invoiceId: invoice.id, revisionNumber: r.revisionNumber },
      input.idempotencyKey,
    );
    return invoice;
  }

  createInvoice(
    actor: ActorContext,
    input: {
      sellerCompanyId?: string;
      customerContactId?: string | null;
      customerCompanyId?: string | null;
      currencyCode: string;
      lines: LineInput[];
      dueDate?: string | null;
      responsibleUserId?: string | null;
    },
  ) {
    this.support.require(actor, "invoice.create");
    if (
      input.responsibleUserId &&
      !this.access.isActiveMember(actor.workspaceId, input.responsibleUserId)
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Responsible user is not an active workspace member.",
        404,
      );
    const seller = this.requisites.resolveSeller(
      actor.workspaceId,
      null,
      input.sellerCompanyId,
    );
    this.validateCustomer(
      actor.workspaceId,
      input.customerContactId,
      input.customerCompanyId,
    );
    return this.createInvoiceInternal(actor, {
      ...input,
      sellerCompanyId: seller.companyId,
      lines: this.lines(actor.workspaceId, input.currencyCode, input.lines),
    });
  }
  private createInvoiceInternal(
    actor: ActorContext,
    input: {
      sellerCompanyId: string;
      customerContactId?: string | null;
      customerCompanyId?: string | null;
      currencyCode: string;
      lines: MoneyLine[];
      dueDate?: string | null;
      responsibleUserId?: string | null;
      sourceEstimateId?: string | null;
      sourceEstimateRevisionId?: string | null;
      dealId?: string | null;
    },
  ) {
    const totals = this.totals(input.lines);
    const row: Invoice = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      invoiceNumber: null,
      semanticStatus: "DRAFT",
      sourceEstimateId: input.sourceEstimateId ?? null,
      sourceEstimateRevisionId: input.sourceEstimateRevisionId ?? null,
      dealId: input.dealId ?? null,
      customerContactId: input.customerContactId ?? null,
      customerCompanyId: input.customerCompanyId ?? null,
      sellerCompanyId: input.sellerCompanyId,
      buyerSnapshotId: null,
      sellerSnapshotId: null,
      currencyCode: input.currencyCode.toUpperCase(),
      issueDate: null,
      dueDate: input.dueDate ?? null,
      ...totals,
      paidAmount: "0",
      outstandingBalance: totals.grandTotal,
      lines: structuredClone(input.lines),
      responsibleUserId: input.responsibleUserId ?? actor.user.id,
      voidReason: null,
      issuedAt: null,
      voidedAt: null,
      archived: false,
      version: 1,
    };
    this.store.state.invoices.push(row);
    this.support.audit(actor, "INVOICE.CREATED", "Invoice", row.id, null, {
      total: row.grandTotal,
    });
    this.support.event(actor, "INVOICE_CREATED", "INVOICE", row.id, {
      total: row.grandTotal,
    });
    return row;
  }
  updateInvoiceDraft(
    actor: ActorContext,
    id: string,
    input: {
      dueDate?: string | null;
      lines?: LineInput[];
      responsibleUserId?: string | null;
    },
  ) {
    const i = this.invoice(actor.workspaceId, id);
    this.support.requireRecord(
      actor,
      "invoice.update_draft",
      i.responsibleUserId,
    );
    if (i.semanticStatus !== "DRAFT")
      throw conflict(
        "INVOICE_IMMUTABLE_AFTER_ISSUE",
        "Only draft invoices can be edited.",
      );
    if (input.lines) {
      i.lines = this.lines(actor.workspaceId, i.currencyCode, input.lines);
      Object.assign(i, this.totals(i.lines));
      i.outstandingBalance = i.grandTotal;
    }
    if (input.dueDate !== undefined) i.dueDate = input.dueDate;
    if (input.responsibleUserId !== undefined) {
      if (
        input.responsibleUserId &&
        !this.access.isActiveMember(actor.workspaceId, input.responsibleUserId)
      )
        throw new AppError(
          "CROSS_WORKSPACE_REFERENCE",
          "Responsible user is not an active workspace member.",
          404,
        );
      i.responsibleUserId = input.responsibleUserId;
    }
    i.version++;
    this.support.audit(actor, "INVOICE.UPDATED", "Invoice", i.id, null, {
      version: i.version,
      total: i.grandTotal,
    });
    this.support.event(actor, "INVOICE_UPDATED", "INVOICE", i.id, {
      version: i.version,
      total: i.grandTotal,
    });
    return i;
  }
  getInvoice(actor: ActorContext, id: string, now = new Date()) {
    const i = this.invoice(actor.workspaceId, id);
    this.support.requireRecord(actor, "invoice.read", i.responsibleUserId);
    return { ...i, isOverdue: this.isOverdue(i, now) };
  }
  listInvoices(actor: ActorContext, now = new Date()) {
    return this.store.state.invoices
      .filter(
        (x) =>
          x.workspaceId === actor.workspaceId &&
          this.support.canReadRecord(
            actor,
            "invoice.read",
            x.responsibleUserId,
          ),
      )
      .map((i) => ({ ...i, isOverdue: this.isOverdue(i, now) }));
  }
  listInvoiceSequences(actor: ActorContext) {
    this.support.require(actor, "seller_company.manage");
    return this.store.state.invoiceSequences
      .filter((x) => x.workspaceId === actor.workspaceId)
      .sort(
        (a, b) =>
          (a.sellerCompanyId ?? "").localeCompare(b.sellerCompanyId ?? "") ||
          a.id.localeCompare(b.id),
      );
  }
  configureInvoiceSequence(
    actor: ActorContext,
    input: {
      sellerCompanyId?: string | null;
      prefix: string;
      nextValue?: number;
      padding?: number;
    },
  ) {
    this.support.require(actor, "seller_company.manage");
    if (
      input.sellerCompanyId &&
      !this.store.state.crmCompanies.some(
        (x) =>
          x.id === input.sellerCompanyId &&
          x.workspaceId === actor.workspaceId &&
          !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Seller company was not found.",
        404,
      );
    const prefix = this.support.text(input.prefix, "prefix", 40);
    if (!/^[A-Za-z0-9._\/-]+$/.test(prefix))
      throw badRequest(
        "INVOICE_SEQUENCE_INVALID",
        "prefix contains unsupported characters.",
      );
    const nextValue = input.nextValue ?? 1,
      padding = input.padding ?? 6;
    if (
      !Number.isSafeInteger(nextValue) ||
      nextValue < 1 ||
      !Number.isInteger(padding) ||
      padding < 1 ||
      padding > 18
    )
      throw badRequest(
        "INVOICE_SEQUENCE_INVALID",
        "nextValue and padding are invalid.",
      );
    let sequence = this.store.state.invoiceSequences.find(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        (x.sellerCompanyId ?? null) === (input.sellerCompanyId ?? null),
    );
    const before = sequence ? structuredClone(sequence) : null;
    if (sequence) {
      if (nextValue < sequence.nextValue)
        throw conflict(
          "INVOICE_SEQUENCE_INVALID",
          "nextValue cannot move backwards.",
        );
      sequence.prefix = prefix;
      sequence.nextValue = nextValue;
      sequence.padding = padding;
    } else {
      sequence = {
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        sellerCompanyId: input.sellerCompanyId ?? null,
        prefix,
        nextValue,
        padding,
      };
      this.store.state.invoiceSequences.push(sequence);
    }
    this.support.audit(
      actor,
      "INVOICE.SEQUENCE_CONFIGURED",
      "InvoiceSequence",
      sequence.id,
      before,
      sequence,
    );
    this.support.event(
      actor,
      "INVOICE_SEQUENCE_CONFIGURED",
      "INVOICE_SEQUENCE",
      sequence.id,
      {
        sellerCompanyId: sequence.sellerCompanyId ?? null,
        prefix: sequence.prefix,
        nextValue: sequence.nextValue,
        padding: sequence.padding,
      },
    );
    return sequence;
  }
  issueInvoice(
    actor: ActorContext,
    id: string,
    parties: { buyer: PartyInput; seller: PartyInput; issueDate?: string },
  ) {
    return this.store.atomicSync(() => {
      const i = this.invoice(actor.workspaceId, id);
      this.support.requireRecord(actor, "invoice.issue", i.responsibleUserId);
      if (i.semanticStatus !== "DRAFT")
        throw conflict("INVOICE_ALREADY_ISSUED", "Invoice is already issued.");
      if (i.lines.length === 0)
        throw badRequest(
          "INVOICE_REQUIRED_DATA_MISSING",
          "Invoice requires lines.",
        );
      const buyer = this.requisites.createSnapshot(
        actor,
        "BUYER",
        parties.buyer,
      );
      const seller = this.requisites.createSnapshot(
        actor,
        "SELLER",
        parties.seller,
      );
      const sequence = this.sequence(actor.workspaceId, i.sellerCompanyId);
      const number = `${sequence.prefix}${String(sequence.nextValue++).padStart(sequence.padding ?? 6, "0")}`;
      if (
        this.store.state.invoices.some(
          (x) =>
            x.workspaceId === actor.workspaceId && x.invoiceNumber === number,
        )
      )
        throw conflict("INVOICE_NUMBER_CONFLICT", "Invoice number conflict.");
      i.buyerSnapshotId = buyer.id;
      i.sellerSnapshotId = seller.id;
      i.invoiceNumber = number;
      i.issueDate = parties.issueDate ?? new Date().toISOString().slice(0, 10);
      if (i.dueDate && i.dueDate < i.issueDate)
        throw badRequest(
          "INVOICE_REQUIRED_DATA_MISSING",
          "dueDate cannot precede issueDate.",
        );
      i.semanticStatus = "ISSUED";
      i.issuedAt = new Date();
      i.version++;
      this.support.audit(actor, "INVOICE.ISSUED", "Invoice", i.id, null, {
        invoiceNumber: number,
        total: i.grandTotal,
      });
      this.support.event(actor, "INVOICE_ISSUED", "INVOICE", i.id, {
        invoiceNumber: number,
        total: i.grandTotal,
      });
      return i;
    });
  }
  voidInvoice(actor: ActorContext, id: string, reason: string) {
    const i = this.invoice(actor.workspaceId, id);
    this.support.requireRecord(actor, "invoice.void", i.responsibleUserId);
    if (toScaled(i.paidAmount)! > 0n)
      throw conflict(
        "INVOICE_HAS_SETTLED_PAYMENT",
        "Refund or reverse settled allocations before voiding.",
      );
    if (i.semanticStatus !== "ISSUED")
      throw conflict(
        "INVOICE_CANNOT_VOID",
        "Invoice cannot be voided in this state.",
      );
    i.semanticStatus = "VOID";
    i.voidReason = this.support.text(reason, "reason");
    i.voidedAt = new Date();
    this.support.audit(actor, "INVOICE.VOIDED", "Invoice", i.id, null, {
      reason: i.voidReason,
    });
    this.support.event(actor, "INVOICE_VOIDED", "INVOICE", i.id);
    return i;
  }
  cancelInvoice(actor: ActorContext, id: string, reason: string) {
    const i = this.invoice(actor.workspaceId, id);
    this.support.requireRecord(actor, "invoice.cancel", i.responsibleUserId);
    if (toScaled(i.paidAmount)! > 0n)
      throw conflict(
        "INVOICE_HAS_SETTLED_PAYMENT",
        "Settled invoice cannot be cancelled.",
      );
    if (!["DRAFT", "ISSUED"].includes(i.semanticStatus))
      throw conflict(
        "INVOICE_STATE_INVALID",
        "Invoice cannot be cancelled in this state.",
      );
    i.semanticStatus = "CANCELLED";
    i.voidReason = this.support.text(reason, "reason");
    this.support.audit(actor, "INVOICE.CANCELLED", "Invoice", i.id, null, {
      reason: i.voidReason,
    });
    this.support.event(actor, "INVOICE_CANCELLED", "INVOICE", i.id);
    return i;
  }
  archiveInvoice(actor: ActorContext, id: string) {
    const i = this.invoice(actor.workspaceId, id);
    this.support.requireRecord(actor, "invoice.archive", i.responsibleUserId);
    i.archived = true;
    this.support.audit(actor, "INVOICE.ARCHIVED", "Invoice", i.id);
    this.support.event(actor, "INVOICE_ARCHIVED", "INVOICE", i.id);
    return i;
  }
  isOverdue(i: Invoice, now = new Date()) {
    return (
      ["ISSUED", "PARTIALLY_PAID"].includes(i.semanticStatus) &&
      toScaled(i.outstandingBalance)! > 0n &&
      !!i.dueDate &&
      i.dueDate < now.toISOString().slice(0, 10)
    );
  }

  recordManualPayment(
    actor: ActorContext,
    input: {
      customerContactId?: string | null;
      customerCompanyId?: string | null;
      amount: string | number;
      currencyCode: string;
      externalReference?: string | null;
      allocations?: Array<{ invoiceId: string; amount: string | number }>;
    },
  ) {
    this.support.require(actor, "payment.record");
    return this.store.atomicSync(() => {
      this.validateCustomer(
        actor.workspaceId,
        input.customerContactId,
        input.customerCompanyId,
      );
      const amount = this.money(input.amount, "amount", true);
      const p: Payment = {
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        customerContactId: input.customerContactId ?? null,
        customerCompanyId: input.customerCompanyId ?? null,
        currencyCode: input.currencyCode.toUpperCase(),
        amount,
        settlementStatus: "SUCCEEDED",
        methodType: "MANUAL",
        providerKey: null,
        externalReference: input.externalReference ?? null,
        receivedAt: new Date(),
        memo: null,
        responsibleUserId: actor.user.id,
      };
      this.store.state.payments.push(p);
      for (const a of input.allocations ?? [])
        this.allocateInternal(actor, p, a.invoiceId, a.amount, "payment.record");
      this.support.audit(actor, "PAYMENT.RECORDED", "Payment", p.id, null, {
        amount,
        currencyCode: p.currencyCode,
      });
      this.support.event(actor, "PAYMENT_CREATED", "PAYMENT", p.id, { amount });
      this.support.event(actor, "PAYMENT_SUCCEEDED", "PAYMENT", p.id, {
        amount,
      });
      return this.paymentView(p);
    });
  }
  allocate(
    actor: ActorContext,
    paymentId: string,
    invoiceId: string,
    amount: string | number,
  ) {
    const p = this.payment(actor.workspaceId, paymentId);
    this.support.requireRecord(actor, "payment.allocate", p.responsibleUserId);
    return this.store.atomicSync(() =>
      this.allocateInternal(actor, p, invoiceId, amount),
    );
  }
  private allocateInternal(
    actor: ActorContext,
    p: Payment,
    invoiceId: string,
    amountRaw: string | number,
    permission = "payment.allocate",
  ) {
    if (p.settlementStatus !== "SUCCEEDED")
      throw conflict("PAYMENT_NOT_SETTLED", "Payment is not settled.");
    const i = this.invoice(actor.workspaceId, invoiceId);
    this.support.requireRecord(actor, permission, i.responsibleUserId);
    if (!["ISSUED", "PARTIALLY_PAID"].includes(i.semanticStatus))
      throw conflict(
        "INVOICE_STATE_INVALID",
        "Invoice is not eligible for allocation.",
      );
    if (i.currencyCode !== p.currencyCode)
      throw conflict(
        "PAYMENT_CURRENCY_MISMATCH",
        "Payment and invoice currency differ.",
      );
    if (
      (p.customerContactId && p.customerContactId !== i.customerContactId) ||
      (p.customerCompanyId && p.customerCompanyId !== i.customerCompanyId)
    )
      throw conflict(
        "PAYMENT_CUSTOMER_MISMATCH",
        "Payment and invoice customers differ.",
      );
    const amount = this.money(amountRaw, "amount", true);
    if (toScaled(amount)! > this.unappliedScaled(p))
      throw conflict(
        "PAYMENT_INSUFFICIENT_UNAPPLIED_AMOUNT",
        "Allocation exceeds unapplied payment amount.",
      );
    if (toScaled(amount)! > toScaled(i.outstandingBalance)!)
      throw conflict(
        "PAYMENT_ALLOCATION_EXCEEDS_INVOICE_BALANCE",
        "Allocation exceeds invoice balance.",
      );
    const row = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      paymentId: p.id,
      invoiceId: i.id,
      amount,
      status: "ACTIVE" as const,
      createdByUserId: actor.user.id,
      reversedAt: null,
      reversalReason: null,
    };
    this.store.state.paymentAllocations.push(row);
    this.recomputeInvoice(i);
    this.support.audit(
      actor,
      "PAYMENT.ALLOCATED",
      "PaymentAllocation",
      row.id,
      null,
      { paymentId: p.id, invoiceId: i.id, amount },
    );
    this.support.event(actor, "PAYMENT_ALLOCATION_CREATED", "PAYMENT", p.id, {
      allocationId: row.id,
      invoiceId: i.id,
      amount,
    });
    this.support.event(
      actor,
      "PAYMENT_UNAPPLIED_BALANCE_CHANGED",
      "PAYMENT",
      p.id,
      { unappliedAmount: this.paymentView(p).unappliedAmount },
    );
    return row;
  }
  reverseAllocation(
    actor: ActorContext,
    paymentId: string,
    allocationId: string,
    reason: string,
  ) {
    const p = this.payment(actor.workspaceId, paymentId);
    this.support.requireRecord(
      actor,
      "payment.reverse_allocation",
      p.responsibleUserId,
    );
    const a = this.store.state.paymentAllocations.find(
      (x) =>
        x.id === allocationId &&
        x.paymentId === p.id &&
        x.workspaceId === actor.workspaceId,
    );
    if (!a)
      throw new AppError(
        "ALLOCATION_NOT_FOUND",
        "Allocation was not found.",
        404,
      );
    if (a.status === "REVERSED")
      throw conflict(
        "ALLOCATION_CANNOT_REVERSE",
        "Allocation is already reversed.",
      );
    a.status = "REVERSED";
    a.reversedAt = new Date();
    a.reversalReason = this.support.text(reason, "reason");
    this.recomputeInvoice(this.invoice(actor.workspaceId, a.invoiceId));
    this.support.audit(
      actor,
      "PAYMENT.ALLOCATION_REVERSED",
      "PaymentAllocation",
      a.id,
      null,
      { reason: a.reversalReason },
    );
    this.support.event(actor, "PAYMENT_ALLOCATION_REVERSED", "PAYMENT", p.id, {
      allocationId,
    });
    return a;
  }
  paymentView(p: Payment) {
    const allocated = sumScaled(
      this.store.state.paymentAllocations
        .filter((x) => x.paymentId === p.id && x.status === "ACTIVE")
        .map((x) => toScaled(x.amount)!),
    );
    const refunded = sumScaled(
      this.store.state.refunds
        .filter((x) => x.paymentId === p.id && x.status === "SUCCEEDED")
        .map((x) => toScaled(x.amount)!),
    );
    return {
      ...p,
      allocatedAmount: fromScaled(allocated),
      refundedAmount: fromScaled(refunded),
      unappliedAmount: fromScaled(toScaled(p.amount)! - allocated - refunded),
    };
  }
  getPayment(actor: ActorContext, id: string) {
    const p = this.payment(actor.workspaceId, id);
    this.support.requireRecord(actor, "payment.read", p.responsibleUserId);
    return this.paymentView(p);
  }
  listAllocations(actor: ActorContext, paymentId: string) {
    const p = this.payment(actor.workspaceId, paymentId);
    this.support.requireRecord(actor, "payment.read", p.responsibleUserId);
    return this.store.state.paymentAllocations.filter(
      (x) => x.workspaceId === actor.workspaceId && x.paymentId === p.id,
    );
  }
  listRefunds(actor: ActorContext, paymentId: string) {
    const p = this.payment(actor.workspaceId, paymentId);
    this.support.requireRecord(actor, "payment.read", p.responsibleUserId);
    return this.store.state.refunds.filter(
      (x) => x.workspaceId === actor.workspaceId && x.paymentId === p.id,
    );
  }
  listPayments(actor: ActorContext) {
    return this.store.state.payments
      .filter(
        (x) =>
          x.workspaceId === actor.workspaceId &&
          this.support.canReadRecord(
            actor,
            "payment.read",
            x.responsibleUserId,
          ),
      )
      .map((x) => this.paymentView(x));
  }

  async createProviderAttempt(
    actor: ActorContext,
    input: {
      providerKey: string;
      invoiceIds: string[];
      idempotencyKey: string;
      merchantId?: string;
    },
  ) {
    if (!input.invoiceIds.length)
      throw badRequest(
        "PAYMENT_AMOUNT_INVALID",
        "At least one invoice is required.",
      );
    const invoices = input.invoiceIds.map((id) =>
      this.invoice(actor.workspaceId, id),
    );
    for (const invoice of invoices)
      this.support.requireRecord(
        actor,
        "payment.create_attempt",
        invoice.responsibleUserId,
      );
    if (
      invoices.some(
        (i) =>
          !["ISSUED", "PARTIALLY_PAID"].includes(i.semanticStatus) ||
          toScaled(i.outstandingBalance)! <= 0n,
      )
    )
      throw conflict(
        "INVOICE_STATE_INVALID",
        "Only unpaid issued invoices are eligible.",
      );
    const customerKey = [
      invoices[0].customerContactId ?? "",
      invoices[0].customerCompanyId ?? "",
    ].join(":");
    if (
      invoices.some(
        (i) =>
          [i.customerContactId ?? "", i.customerCompanyId ?? ""].join(":") !==
          customerKey,
      )
    )
      throw conflict(
        "PAYMENT_CUSTOMER_MISMATCH",
        "Invoices belong to different customers.",
      );
    const currency = invoices[0].currencyCode;
    if (invoices.some((i) => i.currencyCode !== currency))
      throw conflict(
        "PAYMENT_CURRENCY_MISMATCH",
        "Invoices use different currencies.",
      );
    const amount = fromScaled(
      sumScaled(invoices.map((i) => toScaled(i.outstandingBalance)!)),
    );
    const requestIdentity = {
      providerKey: input.providerKey,
      invoiceIds: input.invoiceIds,
      idempotencyKey: input.idempotencyKey,
    };
    const old = this.idempotent(
      actor,
      "payment.attempt",
      input.idempotencyKey,
      requestIdentity,
    );
    if (old)
      return this.store.state.paymentAttempts.find(
        (x) => x.id === old.attemptId,
      )!;
    const adapter = this.providers.get(input.providerKey);
    const merchantId = adapter.merchantIdentity();
    const result = await adapter.createPaymentAttempt({
      amount,
      currencyCode: currency,
      idempotencyKey: input.idempotencyKey,
    });
    const p: Payment = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      customerContactId: invoices[0].customerContactId,
      customerCompanyId: invoices[0].customerCompanyId,
      currencyCode: currency,
      amount,
      settlementStatus: "PENDING",
      methodType: "PROVIDER",
      providerKey: input.providerKey,
      externalReference: null,
      receivedAt: null,
      memo: null,
      responsibleUserId: actor.user.id,
    };
    this.store.state.payments.push(p);
    const attempt = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      paymentId: p.id,
      providerKey: input.providerKey,
      providerTransactionId: result.transactionId,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING" as const,
      requestedAmount: amount,
      currencyCode: currency,
      merchantId,
      failureCode: null,
      invoiceIds: invoices.map((i) => i.id),
    };
    this.store.state.paymentAttempts.push(attempt);
    this.remember(
      actor,
      "payment.attempt",
      input.idempotencyKey,
      requestIdentity,
      { attemptId: attempt.id },
    );
    this.support.event(actor, "PAYMENT_CREATED", "PAYMENT", p.id, {
      providerKey: input.providerKey,
      attemptId: attempt.id,
    });
    return {
      ...attempt,
      checkoutUrl: result.checkoutUrl,
      publicData: result.publicData,
    };
  }
  async handleProviderWebhook(
    providerKey: string,
    connectionKey: string,
    headers: Record<string, string>,
    rawBody: string,
  ) {
    const adapter = this.providers.get(providerKey);
    const event = await adapter.verifyAndParseWebhook(headers, rawBody);
    return this.store.atomicSync(() => {
      const attempt = this.store.state.paymentAttempts.find(
        (x) =>
          x.providerKey === providerKey &&
          !x.lifecycleControlled &&
          x.providerTransactionId === event.transactionId,
      );
      if (!attempt)
        throw new AppError(
          "PAYMENT_PROVIDER_TRANSACTION_MISMATCH",
          "Internal attempt was not found.",
          409,
        );
      const existing = this.store.state.paymentProviderEvents.find(
        (x) =>
          x.providerKey === providerKey &&
          x.connectionKey === connectionKey &&
          x.externalEventId === event.eventId,
      );
      if (existing)
        return {
          duplicate: true,
          payment: this.paymentView(
            this.payment(attempt.workspaceId, attempt.paymentId),
          ),
        };
      if (
        event.eventType === "REFUND_SUCCEEDED" ||
        event.eventType === "REFUND_FAILED"
      ) {
        if (event.transactionId !== attempt.providerTransactionId)
          throw conflict(
            "PAYMENT_PROVIDER_TRANSACTION_MISMATCH",
            "Provider transaction mismatch.",
          );
        if (event.currencyCode !== attempt.currencyCode)
          throw conflict(
            "PAYMENT_PROVIDER_CURRENCY_MISMATCH",
            "Provider currency mismatch.",
          );
        if (attempt.merchantId && event.merchantId !== attempt.merchantId)
          throw conflict(
            "PAYMENT_PROVIDER_MERCHANT_MISMATCH",
            "Provider merchant mismatch.",
          );
        const refund = this.store.state.refunds.find(
          (x) =>
            x.providerAttemptId === attempt.id &&
            (!event.refundId || x.providerRefundId === event.refundId),
        );
        if (!refund)
          throw conflict(
            "REFUND_PROVIDER_FAILED",
            "Internal refund was not found.",
          );
        if (toScaled(event.amount) !== toScaled(refund.amount)!)
          throw conflict(
            "PAYMENT_PROVIDER_AMOUNT_MISMATCH",
            "Provider refund amount mismatch.",
          );
        refund.status =
          event.eventType === "REFUND_SUCCEEDED" ? "SUCCEEDED" : "FAILED";
        refund.settledAt = refund.status === "SUCCEEDED" ? new Date() : null;
        this.store.state.paymentProviderEvents.push({
          id: this.store.id(),
          workspaceId: attempt.workspaceId,
          providerKey,
          connectionKey,
          externalEventId: event.eventId,
          eventType: event.eventType,
          receivedAt: new Date(),
          processedAt: new Date(),
        });
        this.support.serviceEvent(
          refund.workspaceId,
          event.eventType,
          "REFUND",
          refund.id,
          { paymentId: refund.paymentId, amount: refund.amount },
          event.eventId,
        );
        return {
          duplicate: false,
          refund,
          payment: this.paymentView(
            this.payment(attempt.workspaceId, attempt.paymentId),
          ),
        };
      }
      this.validateProviderEvent(attempt, event);
      const p = this.payment(attempt.workspaceId, attempt.paymentId);
      this.store.state.paymentProviderEvents.push({
        id: this.store.id(),
        workspaceId: attempt.workspaceId,
        providerKey,
        connectionKey,
        externalEventId: event.eventId,
        eventType: event.eventType,
        receivedAt: new Date(),
        processedAt: new Date(),
      });
      if (event.eventType === "PAYMENT_SUCCEEDED") {
        if (attempt.status !== "SUCCEEDED") {
          attempt.status = "SUCCEEDED";
          p.settlementStatus = "SUCCEEDED";
          p.receivedAt = new Date();
          for (const invoiceId of attempt.invoiceIds ?? []) {
            const invoice = this.invoice(attempt.workspaceId, invoiceId);
            const amount = invoice.outstandingBalance;
            if (toScaled(amount)! <= 0n) continue;
            if (toScaled(amount)! > this.unappliedScaled(p)) break;
            this.store.state.paymentAllocations.push({
              id: this.store.id(),
              workspaceId: p.workspaceId,
              paymentId: p.id,
              invoiceId: invoice.id,
              amount,
              status: "ACTIVE",
              createdByUserId: null,
              reversedAt: null,
              reversalReason: null,
            });
            this.recomputeInvoice(invoice);
            this.support.serviceEvent(
              p.workspaceId,
              "PAYMENT_ALLOCATION_CREATED",
              "PAYMENT",
              p.id,
              { invoiceId: invoice.id, amount },
            );
          }
          this.support.serviceEvent(
            p.workspaceId,
            "PAYMENT_SUCCEEDED",
            "PAYMENT",
            p.id,
            { attemptId: attempt.id },
          );
        }
      } else if (
        event.eventType === "PAYMENT_FAILED" &&
        attempt.status !== "SUCCEEDED"
      ) {
        attempt.status = "FAILED";
        p.settlementStatus = "FAILED";
        this.support.serviceEvent(
          p.workspaceId,
          "PAYMENT_FAILED",
          "PAYMENT",
          p.id,
          { attemptId: attempt.id },
        );
      }
      return { duplicate: false, payment: this.paymentView(p) };
    });
  }
  browserReturn() {
    return { settled: false, status: "PENDING" };
  }

  requestRefund(
    actor: ActorContext,
    paymentId: string,
    input: {
      amount: string | number;
      currencyCode: string;
      idempotencyKey: string;
      reason?: string;
    },
  ) {
    this.support.require(actor, "payment.refund");
    return this.store.atomicSync(() => {
      const p = this.payment(actor.workspaceId, paymentId);
      this.support.requireRecord(actor, "payment.refund", p.responsibleUserId);
      if ((p as Payment & {flow?:string}).flow === "COMMERCE")
        throw conflict("REFUND_APPROVAL_REQUIRED", "Use the Commerce approval and provider refund lifecycle.");
      if (p.settlementStatus !== "SUCCEEDED")
        throw conflict("REFUND_PAYMENT_NOT_SETTLED", "Payment is not settled.");
      if (input.currencyCode.toUpperCase() !== p.currencyCode)
        throw conflict("REFUND_CURRENCY_MISMATCH", "Refund currency differs.");
      const old = this.idempotent(
        actor,
        `refund:${p.id}`,
        input.idempotencyKey,
        input,
      );
      if (old)
        return this.store.state.refunds.find((x) => x.id === old.refundId)!;
      const amount = this.money(input.amount, "amount", true);
      if (toScaled(amount)! > this.refundableScaled(p))
        throw conflict(
          this.activeAllocated(p) > 0n
            ? "REFUND_REQUIRES_ALLOCATION_ADJUSTMENT"
            : "REFUND_EXCEEDS_AVAILABLE",
          "Refund exceeds available unapplied amount.",
        );
      const row = {
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        paymentId: p.id,
        providerAttemptId: null,
        amount,
        currencyCode: p.currencyCode,
        status: (p.methodType === "MANUAL" ? "SUCCEEDED" : "PENDING") as
          "SUCCEEDED" | "PENDING",
        providerRefundId: null,
        reasonText: input.reason ?? null,
        requestedByUserId: actor.user.id,
        requestedAt: new Date(),
        settledAt: p.methodType === "MANUAL" ? new Date() : null,
        idempotencyKey: input.idempotencyKey,
      };
      this.store.state.refunds.push(row);
      if (p.methodType === "PROVIDER")
        this.store.state.backgroundJobs.push({
          id: this.store.id(),
          workspaceId: p.workspaceId,
          type: "PROVIDER_REFUND",
          key: `refund:${row.id}`,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          runAt: new Date(),
          payload: { refundId: row.id },
          lastError: null,
        });
      this.remember(actor, `refund:${p.id}`, input.idempotencyKey, input, {
        refundId: row.id,
      });
      this.support.audit(actor, "REFUND.REQUESTED", "Refund", row.id, null, {
        paymentId: p.id,
        amount,
      });
      this.support.event(
        actor,
        "REFUND_REQUESTED",
        "REFUND",
        row.id,
        { paymentId: p.id, amount },
        input.idempotencyKey,
      );
      if (row.status === "SUCCEEDED")
        this.support.event(actor, "REFUND_SUCCEEDED", "REFUND", row.id, {
          paymentId: p.id,
          amount,
        });
      return row;
    });
  }

  async processProviderRefund(refundId: string) {
    const refund = this.store.state.refunds.find((x) => x.id === refundId);
    if (!refund)
      throw new AppError("REFUND_NOT_FOUND", "Refund was not found.", 404);
    if ((refund as typeof refund & {flow?:string}).flow === "COMMERCE")
      throw conflict("REFUND_APPROVAL_REQUIRED", "Use the durable Commerce refund worker.");
    if (refund.status === "SUCCEEDED") return refund;
    const payment = this.payment(refund.workspaceId, refund.paymentId);
    const attempt = [...this.store.state.paymentAttempts]
      .reverse()
      .find((x) => x.paymentId === payment.id && x.status === "SUCCEEDED");
    if (!attempt?.providerTransactionId)
      throw conflict(
        "REFUND_PROVIDER_FAILED",
        "Settled provider attempt was not found.",
      );
    const result = await this.providers
      .get(attempt.providerKey)
      .refund({
        transactionId: attempt.providerTransactionId,
        amount: refund.amount,
        currencyCode: refund.currencyCode,
        idempotencyKey: refund.idempotencyKey ?? refund.id,
      });
    refund.providerAttemptId = attempt.id;
    refund.providerRefundId = result.refundId;
    refund.status = result.status;
    if (result.status === "SUCCEEDED") {
      refund.settledAt = new Date();
      this.support.serviceEvent(
        refund.workspaceId,
        "REFUND_SUCCEEDED",
        "REFUND",
        refund.id,
        { paymentId: payment.id, amount: refund.amount },
        refund.idempotencyKey ?? refund.id,
      );
    } else if (result.status === "FAILED")
      this.support.serviceEvent(
        refund.workspaceId,
        "REFUND_FAILED",
        "REFUND",
        refund.id,
        { paymentId: payment.id, amount: refund.amount },
        refund.idempotencyKey ?? refund.id,
      );
    return refund;
  }
  createRecurringRule(
    actor: ActorContext,
    input: Omit<RecurringRule, "id" | "workspaceId" | "version">,
  ) {
    this.support.require(actor, "recurring_invoice.create");
    this.requisites.resolveSeller(
      actor.workspaceId,
      null,
      input.sellerCompanyId,
    );
    this.validateCustomer(
      actor.workspaceId,
      input.customerContactId,
      input.customerCompanyId,
    );
    this.validateRecurring(input);
    const row = {
      ...structuredClone(input),
      responsibleUserId: input.responsibleUserId ?? actor.user.id,
      recurrence: input.recurrence ?? {
        frequency: "MONTHLY" as const,
        interval: 1,
      },
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      version: 1,
    };
    this.store.state.recurringRules.push(row);
    this.support.audit(
      actor,
      "RECURRING_INVOICE.CREATED",
      "RecurringRule",
      row.id,
      null,
      { name: row.name, nextRunAt: row.nextRunAt },
    );
    this.support.event(
      actor,
      "RECURRING_RULE_CREATED",
      "RECURRING_RULE",
      row.id,
      { nextRunAt: row.nextRunAt },
    );
    return row;
  }
  listRecurringRules(actor: ActorContext) {
    this.support.require(actor, "recurring_invoice.read");
    return this.store.state.recurringRules.filter(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        this.support.canReadRecord(
          actor,
          "recurring_invoice.read",
          x.responsibleUserId,
        ),
    );
  }
  getRecurringRule(actor: ActorContext, id: string) {
    const rule = this.recurringRule(actor.workspaceId, id);
    this.support.requireRecord(
      actor,
      "recurring_invoice.read",
      rule.responsibleUserId,
    );
    return {
      ...rule,
      occurrences: this.store.state.recurringOccurrences.filter(
        (x) => x.ruleId === id,
      ),
    };
  }
  updateRecurringRule(
    actor: ActorContext,
    id: string,
    input: Partial<
      Omit<RecurringRule, "id" | "workspaceId" | "version" | "active">
    >,
  ) {
    const rule = this.recurringRule(actor.workspaceId, id);
    this.support.requireRecord(
      actor,
      "recurring_invoice.update",
      rule.responsibleUserId,
    );
    const candidate = { ...rule, ...structuredClone(input) };
    this.requisites.resolveSeller(
      actor.workspaceId,
      null,
      candidate.sellerCompanyId,
    );
    this.validateCustomer(
      actor.workspaceId,
      candidate.customerContactId,
      candidate.customerCompanyId,
    );
    this.validateRecurring(candidate);
    Object.assign(rule, structuredClone(input));
    rule.version++;
    this.support.audit(
      actor,
      "RECURRING_INVOICE.UPDATED",
      "RecurringRule",
      rule.id,
      null,
      { version: rule.version },
    );
    this.support.event(
      actor,
      "RECURRING_RULE_UPDATED",
      "RECURRING_RULE",
      rule.id,
      { version: rule.version },
    );
    return rule;
  }
  setRecurringActive(actor: ActorContext, id: string, active: boolean) {
    const rule = this.recurringRule(actor.workspaceId, id);
    this.support.requireRecord(
      actor,
      active ? "recurring_invoice.activate" : "recurring_invoice.deactivate",
      rule.responsibleUserId,
    );
    rule.active = active;
    rule.version++;
    this.support.audit(
      actor,
      active ? "RECURRING_INVOICE.ACTIVATED" : "RECURRING_INVOICE.DEACTIVATED",
      "RecurringRule",
      rule.id,
    );
    this.support.event(
      actor,
      active ? "RECURRING_RULE_ACTIVATED" : "RECURRING_RULE_DEACTIVATED",
      "RECURRING_RULE",
      rule.id,
    );
    return rule;
  }
  enqueueDueRecurring(actor: ActorContext, now = new Date()) {
    this.support.require(actor, "recurring_invoice.update");
    const jobs = [];
    for (const rule of this.store.state.recurringRules.filter(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        x.active &&
        x.nextRunAt <= now &&
        this.support.canReadRecord(
          actor,
          "recurring_invoice.update",
          x.responsibleUserId,
        ),
    )) {
      if (
        rule.endOn &&
        rule.nextRunAt.toISOString().slice(0, 10) > rule.endOn
      ) {
        rule.active = false;
        continue;
      }
      const occurrenceKey = rule.nextRunAt.toISOString();
      const key = `recurring:${rule.id}:${occurrenceKey}`;
      let job = this.store.state.backgroundJobs.find(
        (x) => x.workspaceId === actor.workspaceId && x.key === key,
      );
      if (!job) {
        job = {
          id: this.store.id(),
          workspaceId: actor.workspaceId,
          type: "RECURRING_INVOICE",
          key,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          runAt: new Date(),
          payload: {
            ruleId: rule.id,
            occurrenceKey,
            scheduledFor: occurrenceKey,
            actorUserId: actor.user.id,
          },
          lastError: null,
        };
        this.store.state.backgroundJobs.push(job);
      }
      jobs.push(job);
    }
    return jobs;
  }
  runRecurring(
    actor: ActorContext,
    ruleId: string,
    occurrenceKey: string,
    scheduledFor: Date,
  ) {
    const rule = this.recurringRule(actor.workspaceId, ruleId);
    if (!rule.active)
      throw conflict("RECURRING_RULE_INVALID", "Recurring rule is inactive.");
    let occurrence = this.store.state.recurringOccurrences.find(
      (x) => x.ruleId === rule.id && x.occurrenceKey === occurrenceKey,
    );
    if (occurrence?.invoiceId)
      return this.invoice(actor.workspaceId, occurrence.invoiceId);
    if (!occurrence) {
      occurrence = {
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        ruleId: rule.id,
        occurrenceKey,
        scheduledFor,
        status: "PENDING",
        invoiceId: null,
        failureCode: null,
      };
      this.store.state.recurringOccurrences.push(occurrence);
    }
    try {
      const invoice = this.store.atomicSync(() => {
        const tpl = rule.template as any;
        const created = this.createInvoice(actor, {
          sellerCompanyId: rule.sellerCompanyId,
          customerContactId: rule.customerContactId,
          customerCompanyId: rule.customerCompanyId,
          currencyCode: rule.currencyCode,
          lines: tpl.lines ?? [],
          dueDate: tpl.dueDate ?? null,
          responsibleUserId: rule.responsibleUserId,
        });
        if (rule.issueMode === "AUTO_ISSUE_SEND")
          this.issueInvoice(actor, created.id, tpl.parties);
        occurrence!.invoiceId = created.id;
        occurrence!.status = "CREATED";
        occurrence!.failureCode = null;
        return created;
      });
      rule.nextRunAt = this.nextRecurringRun(rule, scheduledFor);
      rule.version++;
      this.support.event(
        actor,
        "RECURRING_INVOICE_CREATED",
        "RECURRING_RULE",
        rule.id,
        { occurrenceKey, invoiceId: invoice.id },
        occurrenceKey,
      );
      return invoice;
    } catch (error) {
      occurrence.status = "FAILED";
      occurrence.failureCode =
        (error as { code?: string }).code ?? "RECURRING_OCCURRENCE_FAILED";
      this.support.serviceEvent(
        rule.workspaceId,
        "RECURRING_INVOICE_FAILED",
        "RECURRING_RULE",
        rule.id,
        { occurrenceKey, failureCode: occurrence.failureCode },
        occurrenceKey,
      );
      throw error;
    }
  }

  private lines(
    workspaceId: string,
    currencyRaw: string,
    inputs: LineInput[],
  ): MoneyLine[] {
    const currency = currencyRaw.toUpperCase();
    if (
      !isValidCurrency(currency) ||
      !Array.isArray(inputs) ||
      inputs.length === 0
    )
      throw badRequest(
        "ESTIMATE_TOTAL_INVALID",
        "Valid currency and at least one line are required.",
      );
    return inputs.map((x, index) => {
      if (
        x.productId &&
        !this.store.state.catalogProducts.some(
          (p) => p.id === x.productId && p.workspaceId === workspaceId,
        )
      )
        throw new AppError(
          "CROSS_WORKSPACE_REFERENCE",
          "Product was not found in this workspace.",
          404,
        );
      const quantity = toScaled(x.quantity),
        unitPrice = toScaled(x.unitPrice),
        discount = toScaled(x.discountValue ?? 0),
        tax = toScaled(x.taxRate ?? 0);
      if (
        quantity === null ||
        quantity <= 0n ||
        unitPrice === null ||
        unitPrice < 0n ||
        discount === null ||
        discount < 0n ||
        tax === null ||
        tax < 0n
      )
        throw badRequest(
          "ESTIMATE_TOTAL_INVALID",
          "Line contains invalid decimal values.",
        );
      const dt = x.discountType ?? "NONE";
      if (dt === "PERCENT" && discount > toScaled("100")!)
        throw badRequest(
          "ESTIMATE_TOTAL_INVALID",
          "Percentage discount cannot exceed 100.",
        );
      if (dt === "FIXED" && !fitsCurrency(discount, currency))
        throw badRequest(
          "ESTIMATE_TOTAL_INVALID",
          "Fixed discount exceeds currency precision.",
        );
      let amounts;
      try {
        amounts = calculateRow(
          quantity,
          unitPrice,
          { type: dt === "FIXED" ? "AMOUNT" : dt, value: discount },
          { taxable: tax > 0n, rate: tax, included: false },
          currency,
        );
      } catch {
        throw badRequest(
          "ESTIMATE_TOTAL_INVALID",
          "Discount exceeds the line amount.",
        );
      }
      return {
        id: this.store.id(),
        productId: x.productId ?? null,
        description: this.support.text(x.description, "description"),
        quantity: fromScaled(quantity),
        unitCode: x.unitCode ?? null,
        unitPrice: fromScaled(unitPrice),
        discountType: dt,
        discountValue: fromScaled(discount),
        taxCode: x.taxCode ?? null,
        taxRate: fromScaled(tax),
        netAmount: fromScaled(amounts.subtotal),
        discountAmount: fromScaled(amounts.discountAmount),
        taxAmount: fromScaled(amounts.taxAmount),
        totalAmount: fromScaled(amounts.total),
        sortOrder: x.sortOrder ?? index,
      };
    });
  }
  private totals(lines: MoneyLine[]) {
    return {
      subtotal: fromScaled(sumScaled(lines.map((x) => toScaled(x.netAmount)!))),
      discountTotal: fromScaled(
        sumScaled(lines.map((x) => toScaled(x.discountAmount)!)),
      ),
      taxTotal: fromScaled(sumScaled(lines.map((x) => toScaled(x.taxAmount)!))),
      grandTotal: fromScaled(
        sumScaled(lines.map((x) => toScaled(x.totalAmount)!)),
      ),
    };
  }
  private estimate(workspaceId: string, id: string) {
    const e = this.store.state.estimates.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!e)
      throw new AppError("ESTIMATE_NOT_FOUND", "Estimate was not found.", 404);
    return e;
  }
  private ensureEstimateStages(workspaceId: string) {
    if (
      this.store.state.estimateStages.some((x) => x.workspaceId === workspaceId)
    )
      return;
    (
      [
        "DRAFT",
        "ACTIVE",
        "ACCEPTED",
        "DECLINED",
        "EXPIRED",
        "CONVERTED",
      ] as EstimateStatus[]
    ).forEach((semanticStatus, position) =>
      this.store.state.estimateStages.push({
        id: this.store.id(),
        workspaceId,
        name: semanticStatus[0] + semanticStatus.slice(1).toLowerCase(),
        semanticStatus,
        position,
        active: true,
        isDefault: semanticStatus === "DRAFT",
        version: 1,
      }),
    );
  }
  private resolveEstimateStage(workspaceId: string, value: string) {
    this.ensureEstimateStages(workspaceId);
    const normalized = value.trim().toLowerCase();
    const stage = this.store.state.estimateStages.find(
      (x) =>
        x.workspaceId === workspaceId &&
        x.active &&
        (x.id === value ||
          x.name.toLowerCase() === normalized ||
          x.semanticStatus.toLowerCase() === normalized),
    );
    if (!stage)
      throw new AppError(
        "ESTIMATE_STAGE_INVALID",
        "Estimate stage is invalid.",
        409,
      );
    return stage;
  }
  private setEstimateSemantic(estimate: Estimate, status: EstimateStatus) {
    this.ensureEstimateStages(estimate.workspaceId);
    const stage = this.store.state.estimateStages
      .filter(
        (x) =>
          x.workspaceId === estimate.workspaceId &&
          x.active &&
          x.semanticStatus === status,
      )
      .sort((a, b) => a.position - b.position)[0];
    if (!stage)
      throw conflict(
        "ESTIMATE_STAGE_INVALID",
        `No active ${status} Estimate stage is configured.`,
      );
    estimate.semanticStatus = status;
    estimate.stageId = stage.id;
  }
  private invoice(workspaceId: string, id: string) {
    const i = this.store.state.invoices.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!i)
      throw new AppError("INVOICE_NOT_FOUND", "Invoice was not found.", 404);
    return i;
  }
  private payment(workspaceId: string, id: string) {
    const p = this.store.state.payments.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!p)
      throw new AppError("PAYMENT_NOT_FOUND", "Payment was not found.", 404);
    return p;
  }
  private recurringRule(workspaceId: string, id: string) {
    const rule = this.store.state.recurringRules.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!rule)
      throw new AppError(
        "RECURRING_RULE_NOT_FOUND",
        "Recurring rule was not found.",
        404,
      );
    return rule;
  }
  private validateRecurring(
    input: Pick<
      RecurringRule,
      "ianaTimezone" | "startOn" | "endOn" | "nextRunAt" | "recurrence"
    >,
  ) {
    try {
      Intl.DateTimeFormat("en", { timeZone: input.ianaTimezone }).format(
        new Date(),
      );
    } catch {
      throw badRequest("RECURRING_RULE_INVALID", "ianaTimezone is invalid.");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.startOn) ||
      (input.endOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.endOn)) ||
      Number.isNaN(new Date(input.nextRunAt).getTime())
    )
      throw badRequest(
        "RECURRING_RULE_INVALID",
        "Recurring dates are invalid.",
      );
    if (input.endOn && input.endOn < input.startOn)
      throw badRequest(
        "RECURRING_RULE_INVALID",
        "endOn cannot precede startOn.",
      );
    if (
      input.recurrence &&
      (!["DAILY", "WEEKLY", "MONTHLY"].includes(input.recurrence.frequency) ||
        !Number.isInteger(input.recurrence.interval) ||
        input.recurrence.interval < 1 ||
        input.recurrence.interval > 120)
    )
      throw badRequest("RECURRING_RULE_INVALID", "Recurrence is invalid.");
  }
  private nextRecurringRun(rule: RecurringRule, from: Date) {
    const recurrence = rule.recurrence ?? {
      frequency: "MONTHLY" as const,
      interval: 1,
    };
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: rule.ianaTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(from);
    const get = (key: string) =>
      Number(parts.find((x) => x.type === key)?.value);
    const local = new Date(
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      ),
    );
    if (recurrence.frequency === "DAILY")
      local.setUTCDate(local.getUTCDate() + recurrence.interval);
    else if (recurrence.frequency === "WEEKLY")
      local.setUTCDate(local.getUTCDate() + 7 * recurrence.interval);
    else local.setUTCMonth(local.getUTCMonth() + recurrence.interval);
    const desired = [
      local.getUTCFullYear(),
      local.getUTCMonth() + 1,
      local.getUTCDate(),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ];
    let guess = new Date(
      Date.UTC(
        desired[0],
        desired[1] - 1,
        desired[2],
        desired[3],
        desired[4],
        desired[5],
      ),
    );
    for (let n = 0; n < 3; n++) {
      const actual = formatter.formatToParts(guess);
      const value = (key: string) =>
        Number(actual.find((x) => x.type === key)?.value);
      const rendered = Date.UTC(
        value("year"),
        value("month") - 1,
        value("day"),
        value("hour"),
        value("minute"),
        value("second"),
      );
      const wanted = Date.UTC(
        desired[0],
        desired[1] - 1,
        desired[2],
        desired[3],
        desired[4],
        desired[5],
      );
      guess = new Date(guess.getTime() + wanted - rendered);
    }
    return guess;
  }
  private currentRevision(e: Estimate) {
    return e.revisions.find(
      (x) => x.revisionNumber === e.currentRevisionNumber,
    )!;
  }
  private sequence(workspaceId: string, sellerCompanyId: string) {
    let s =
      this.store.state.invoiceSequences.find(
        (x) =>
          x.workspaceId === workspaceId &&
          x.sellerCompanyId === sellerCompanyId,
      ) ??
      this.store.state.invoiceSequences.find(
        (x) => x.workspaceId === workspaceId && !x.sellerCompanyId,
      );
    if (!s) {
      s = {
        id: this.store.id(),
        workspaceId,
        sellerCompanyId: null,
        prefix: "INV-",
        nextValue: 1,
        padding: 6,
      };
      this.store.state.invoiceSequences.push(s);
    }
    return s;
  }
  private validateCustomer(
    workspaceId: string,
    contactId?: string | null,
    companyId?: string | null,
  ) {
    if (!contactId && !companyId)
      throw badRequest(
        "INVOICE_REQUIRED_DATA_MISSING",
        "A customer is required.",
      );
    if (
      contactId &&
      !this.store.state.crmContacts.some(
        (x) =>
          x.id === contactId && x.workspaceId === workspaceId && !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Customer contact was not found.",
        404,
      );
    if (
      companyId &&
      !this.store.state.crmCompanies.some(
        (x) =>
          x.id === companyId && x.workspaceId === workspaceId && !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Customer company was not found.",
        404,
      );
  }
  private recomputeInvoice(i: Invoice) {
    const previous = i.semanticStatus;
    const paid = sumScaled(
      this.store.state.paymentAllocations
        .filter((a) => a.invoiceId === i.id && a.status === "ACTIVE")
        .filter((a) =>
          this.store.state.payments.some(
            (p) => p.id === a.paymentId && p.settlementStatus === "SUCCEEDED",
          ),
        )
        .map((a) => toScaled(a.amount)!),
    );
    const total = toScaled(i.grandTotal)!;
    i.paidAmount = fromScaled(paid);
    i.outstandingBalance = fromScaled(total > paid ? total - paid : 0n);
    if (!["VOID", "CANCELLED"].includes(i.semanticStatus))
      i.semanticStatus =
        paid === 0n ? "ISSUED" : paid < total ? "PARTIALLY_PAID" : "PAID";
    if (
      i.semanticStatus !== previous &&
      (i.semanticStatus === "PARTIALLY_PAID" || i.semanticStatus === "PAID")
    )
      this.support.serviceEvent(
        i.workspaceId,
        i.semanticStatus === "PAID" ? "INVOICE_PAID" : "INVOICE_PARTIALLY_PAID",
        "INVOICE",
        i.id,
        { paidAmount: i.paidAmount, outstandingBalance: i.outstandingBalance },
      );
  }
  private activeAllocated(p: Payment) {
    return sumScaled(
      this.store.state.paymentAllocations
        .filter((x) => x.paymentId === p.id && x.status === "ACTIVE")
        .map((x) => toScaled(x.amount)!),
    );
  }
  private unappliedScaled(p: Payment) {
    const refunded = sumScaled(
      this.store.state.refunds
        .filter((x) => x.paymentId === p.id && x.status === "SUCCEEDED")
        .map((x) => toScaled(x.amount)!),
    );
    return toScaled(p.amount)! - this.activeAllocated(p) - refunded;
  }
  private refundableScaled(p: Payment) {
    const reserved = sumScaled(
      this.store.state.refunds
        .filter(
          (x) =>
            x.paymentId === p.id &&
            (x.status === "PENDING" || x.status === "SUCCEEDED"),
        )
        .map((x) => toScaled(x.amount)!),
    );
    return toScaled(p.amount)! - this.activeAllocated(p) - reserved;
  }
  private money(v: unknown, field: string, positive = false) {
    const n = toScaled(v);
    if (n === null || (positive ? n <= 0n : n < 0n))
      throw badRequest("PAYMENT_AMOUNT_INVALID", `${field} is invalid.`);
    return fromScaled(n);
  }
  private validateProviderEvent(
    attempt: {
      requestedAmount: string;
      currencyCode: string;
      merchantId?: string | null;
      providerTransactionId?: string | null;
    },
    event: VerifiedProviderEvent,
  ) {
    if (event.transactionId !== attempt.providerTransactionId)
      throw conflict(
        "PAYMENT_PROVIDER_TRANSACTION_MISMATCH",
        "Provider transaction mismatch.",
      );
    if (toScaled(event.amount) !== toScaled(attempt.requestedAmount)!)
      throw conflict(
        "PAYMENT_PROVIDER_AMOUNT_MISMATCH",
        "Provider amount mismatch.",
      );
    if (event.currencyCode !== attempt.currencyCode)
      throw conflict(
        "PAYMENT_PROVIDER_CURRENCY_MISMATCH",
        "Provider currency mismatch.",
      );
    if (attempt.merchantId && event.merchantId !== attempt.merchantId)
      throw conflict(
        "PAYMENT_PROVIDER_MERCHANT_MISMATCH",
        "Provider merchant mismatch.",
      );
  }
  private idempotent(
    actor: ActorContext,
    operation: string,
    key: string,
    payload: unknown,
  ) {
    const found = this.store.state.idempotencyRecords.find(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        x.operation === operation &&
        x.idempotencyKey === key,
    );
    if (!found) return null;
    if (found.requestHash !== stableHash(payload))
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key was reused with a different request.",
      );
    return found.response;
  }
  private remember(
    actor: ActorContext,
    operation: string,
    key: string,
    payload: unknown,
    response: Record<string, unknown>,
  ) {
    this.store.state.idempotencyRecords.push({
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      actorUserId: actor.user.id,
      operation,
      idempotencyKey: key,
      requestHash: stableHash(payload),
      response,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    });
  }
}
