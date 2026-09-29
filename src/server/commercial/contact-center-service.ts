import type { ActorContext } from "../access-service";
import { AppError, conflict } from "../errors";
import type { InMemoryStore } from "../store";
import type {
  Channel,
  ContactQueue,
  Conversation,
  ConversationMessage,
  QueueMember,
  SlaPolicy,
  SlaTimer,
  WorkCalendar,
} from "./types";
import { CommercialSupport } from "./support";
import type {
  ChannelConnectorRegistry,
  NormalizedChannelEvent,
} from "./channel-connectors";
import type { CrmCoreService } from "../crm-core-service";
import type { CrmPipelineService } from "../crm-pipeline-service";

type Access = {
  requireScope(actor: ActorContext, key: string): unknown;
  scopeFor(actor: ActorContext, key: string): unknown;
  isActiveMember(workspaceId: string, userId: string): boolean;
};

export class ContactCenterService {
  readonly support: CommercialSupport;
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: Access,
    readonly connectors: ChannelConnectorRegistry,
    private readonly crmCore?: CrmCoreService,
    private readonly crm?: CrmPipelineService,
  ) {
    this.support = new CommercialSupport(store, access);
  }
  createChannel(
    actor: ActorContext,
    input: {
      name: string;
      type: string;
      unknownCustomerPolicy?: Channel["unknownCustomerPolicy"];
      serviceUserId?: string | null;
    },
  ) {
    this.support.require(actor, "contact_center.channel_manage");
    const policy = input.unknownCustomerPolicy ?? "KEEP_UNLINKED";
    if (
      input.serviceUserId &&
      !this.access.isActiveMember(actor.workspaceId, input.serviceUserId)
    )
      throw conflict(
        "CHANNEL_CONFIGURATION_INVALID",
        "Channel service user must be an active workspace member.",
      );
    if (
      ["CREATE_CONTACT", "CREATE_LEAD"].includes(policy) &&
      !input.serviceUserId
    )
      throw conflict(
        "CHANNEL_CONFIGURATION_INVALID",
        "Automatic customer creation requires a configured service user.",
      );
    const row: Channel = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      name: this.support.text(input.name, "name"),
      type: input.type,
      active: true,
      serviceUserId: input.serviceUserId ?? null,
      unknownCustomerPolicy: policy,
    };
    this.store.state.communicationChannels.push(row);
    this.support.audit(
      actor,
      "CONTACT_CENTER.CHANNEL_CREATED",
      "Channel",
      row.id,
      null,
      row,
    );
    return row;
  }
  createConnection(
    actor: ActorContext,
    input: {
      channelId: string;
      providerKey: string;
      externalAccountId?: string;
      capabilities?: string[];
      secretReference?: string;
    },
  ) {
    this.support.require(actor, "contact_center.channel_manage");
    const channel = this.channel(actor.workspaceId, input.channelId);
    const connector = this.connectors.get(input.providerKey);
    const supported = connector.capabilities();
    const row = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      channelId: channel.id,
      providerKey: input.providerKey,
      channelType: channel.type,
      status: "ACTIVE" as const,
      externalAccountId: input.externalAccountId ?? null,
      capabilities: [...(input.capabilities ?? supported.deliveryStates)],
      secretReference: input.secretReference ?? null,
    };
    this.store.state.channelConnections.push(row);
    this.support.audit(
      actor,
      "CONTACT_CENTER.CONNECTION_CREATED",
      "ChannelConnection",
      row.id,
      null,
      { ...row, secretReference: row.secretReference ? "[REDACTED]" : null },
    );
    return this.safeConnection(row);
  }
  listChannels(actor: ActorContext) {
    this.support.require(actor, "conversation.read");
    return this.store.state.communicationChannels
      .filter((x) => x.workspaceId === actor.workspaceId)
      .map((channel) => ({
        ...channel,
        connections: this.store.state.channelConnections
          .filter((x) => x.channelId === channel.id)
          .map((x) => this.safeConnection(x)),
      }));
  }
  createQueue(
    actor: ActorContext,
    input: {
      name: string;
      channelId?: string | null;
      routingMode: ContactQueue["routingMode"];
      fixedUserId?: string | null;
      maxConcurrentPerAgent?: number | null;
      reopenWindowMinutes?: number;
      workCalendar?: WorkCalendar;
      slaPolicyId?: string | null;
      departmentIds?: string[];
      routingRules?: ContactQueue["routingRules"];
    },
  ) {
    this.support.require(actor, "contact_center.queue_manage");
    if (input.channelId) this.channel(actor.workspaceId, input.channelId);
    if (input.slaPolicyId) this.slaPolicy(actor.workspaceId, input.slaPolicyId);
    this.validateQueueConfig(actor.workspaceId, input);
    const row: ContactQueue = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      name: this.support.text(input.name, "name"),
      channelId: input.channelId ?? null,
      routingMode: input.routingMode,
      fixedUserId: input.fixedUserId ?? null,
      maxConcurrentPerAgent: input.maxConcurrentPerAgent ?? null,
      reopenWindowMinutes: input.reopenWindowMinutes ?? 1440,
      active: true,
      roundRobinCursor: 0,
      workCalendar: input.workCalendar,
      slaPolicyId: input.slaPolicyId ?? null,
      departmentIds: structuredClone(input.departmentIds ?? []),
      routingRules: structuredClone(input.routingRules ?? []),
    };
    this.store.state.contactCenterQueues.push(row);
    this.support.audit(
      actor,
      "CONTACT_CENTER.QUEUE_CREATED",
      "ContactQueue",
      row.id,
      null,
      row,
    );
    return row;
  }
  updateQueue(
    actor: ActorContext,
    id: string,
    input: Partial<
      Pick<
        ContactQueue,
        | "name"
        | "channelId"
        | "routingMode"
        | "fixedUserId"
        | "maxConcurrentPerAgent"
        | "reopenWindowMinutes"
        | "active"
        | "workCalendar"
        | "slaPolicyId"
        | "departmentIds"
        | "routingRules"
      >
    >,
  ) {
    this.support.require(actor, "contact_center.queue_manage");
    const q = this.queue(actor.workspaceId, id);
    if (input.channelId) this.channel(actor.workspaceId, input.channelId);
    if (input.slaPolicyId) this.slaPolicy(actor.workspaceId, input.slaPolicyId);
    this.validateQueueConfig(actor.workspaceId, { ...q, ...input });
    Object.assign(q, structuredClone(input));
    this.support.audit(
      actor,
      "CONTACT_CENTER.QUEUE_UPDATED",
      "ContactQueue",
      q.id,
      null,
      input,
    );
    return q;
  }
  addQueueMember(
    actor: ActorContext,
    queueId: string,
    input: {
      userId: string;
      order?: number;
      capacityOverride?: number | null;
      available?: boolean;
      absent?: boolean;
    },
  ) {
    this.support.require(actor, "contact_center.queue_manage");
    const q = this.queue(actor.workspaceId, queueId);
    if (!this.access.isActiveMember(actor.workspaceId, input.userId))
      throw conflict(
        "CONVERSATION_ASSIGNMENT_INVALID",
        "Queue member must be active.",
      );
    const row: QueueMember = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      queueId: q.id,
      userId: input.userId,
      order:
        input.order ??
        this.store.state.contactCenterQueueMembers.filter(
          (x) => x.queueId === q.id,
        ).length,
      capacityOverride: input.capacityOverride ?? null,
      active: true,
      available: input.available ?? true,
      absent: input.absent ?? false,
    };
    this.store.state.contactCenterQueueMembers.push(row);
    return row;
  }
  listQueues(actor: ActorContext) {
    this.support.require(actor, "contact_center.queue_manage");
    return this.store.state.contactCenterQueues.filter(
      (x) => x.workspaceId === actor.workspaceId,
    );
  }
  listConnections(actor: ActorContext, channelId: string) {
    this.support.require(actor, "contact_center.channel_manage");
    this.channel(actor.workspaceId, channelId);
    return this.store.state.channelConnections
      .filter(
        (x) => x.workspaceId === actor.workspaceId && x.channelId === channelId,
      )
      .map((x) => this.safeConnection(x));
  }
  listSlaPolicies(actor: ActorContext) {
    this.support.require(actor, "contact_center.queue_manage");
    return this.store.state.slaPolicies.filter(
      (x) => x.workspaceId === actor.workspaceId,
    );
  }
  createSlaPolicy(
    actor: ActorContext,
    input: {
      name: string;
      firstResponseMinutes: number;
      nextResponseMinutes: number;
      resolutionMinutes: number;
      pauseOnWaitingCustomer?: boolean;
      transferBehavior?: "CONTINUE" | "RESET";
    },
  ) {
    this.support.require(actor, "contact_center.queue_manage");
    this.validateSlaPolicy(input);
    const row: SlaPolicy = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      name: this.support.text(input.name, "name"),
      version: 1,
      active: true,
      firstResponseMinutes: input.firstResponseMinutes,
      nextResponseMinutes: input.nextResponseMinutes,
      resolutionMinutes: input.resolutionMinutes,
      pauseOnWaitingCustomer: Boolean(input.pauseOnWaitingCustomer),
      transferBehavior: input.transferBehavior ?? "CONTINUE",
    };
    this.store.state.slaPolicies.push(row);
    this.support.audit(
      actor,
      "CONTACT_CENTER.SLA_POLICY_CREATED",
      "SlaPolicy",
      row.id,
      null,
      row,
    );
    return row;
  }
  updateSlaPolicy(
    actor: ActorContext,
    id: string,
    input: Partial<Omit<SlaPolicy, "id" | "workspaceId" | "version">>,
  ) {
    this.support.require(actor, "contact_center.queue_manage");
    const policy = this.slaPolicy(actor.workspaceId, id);
    const candidate = { ...policy, ...input };
    this.validateSlaPolicy(candidate);
    Object.assign(policy, structuredClone(input));
    policy.version++;
    this.support.audit(
      actor,
      "CONTACT_CENTER.SLA_POLICY_UPDATED",
      "SlaPolicy",
      policy.id,
      null,
      { version: policy.version, ...input },
    );
    return policy;
  }
  getSla(actor: ActorContext, conversationId: string) {
    this.support.require(actor, "conversation.read");
    this.conversation(actor.workspaceId, conversationId);
    return this.store.state.slaTimers.filter(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        x.conversationId === conversationId,
    );
  }

  async inbound(
    connectionId: string,
    headers: Record<string, string>,
    rawBody: string,
    now = new Date(),
  ) {
    const connection = this.store.state.channelConnections.find(
      (x) => x.id === connectionId && x.status === "ACTIVE",
    );
    if (!connection)
      throw new AppError(
        "CHANNEL_CONNECTION_INACTIVE",
        "Channel connection is inactive.",
        404,
      );
    const connector = this.connectors.get(connection.providerKey);
    const verified = await connector.verifyInbound(headers, rawBody);
    const event = connector.normalizeInbound(verified);
    return this.store.atomicSync(() => {
      const duplicate = this.store.state.channelProviderEvents.find(
        (x) =>
          x.connectionId === connection.id &&
          x.externalEventId === event.eventId,
      );
      if (duplicate) {
        const msg = this.store.state.conversationMessages.find(
          (x) =>
            x.externalMessageId === event.externalMessageId &&
            x.workspaceId === connection.workspaceId &&
            (!x.connectionId || x.connectionId === connection.id),
        );
        return { duplicate: true, message: msg };
      }
      const duplicateMessage = this.store.state.conversationMessages.find(
        (x) =>
          x.workspaceId === connection.workspaceId &&
          x.connectionId === connection.id &&
          x.externalMessageId === event.externalMessageId,
      );
      if (duplicateMessage)
        return { duplicate: true, message: duplicateMessage };
      if (event.eventType !== "MESSAGE") {
        const result = this.applyDelivery(
          connection.workspaceId,
          connection.id,
          event,
          connector.capabilities().deliveryStates,
        );
        this.store.state.channelProviderEvents.push({
          id: this.store.id(),
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          externalEventId: event.eventId,
          externalMessageId: event.externalMessageId,
          createdAt: now,
        });
        return result;
      }
      const identity = this.resolveIdentity(connection, event.externalIdentity);
      const channel = this.channel(
        connection.workspaceId,
        connection.channelId,
      );
      if (!identity.contactId && !identity.companyId && !identity.ambiguous)
        this.applyUnknownCustomerPolicy(
          channel,
          identity,
          event.externalIdentity,
        );
      const queue = this.store.state.contactCenterQueues.find(
        (x) =>
          x.workspaceId === connection.workspaceId &&
          x.active &&
          (x.channelId === channel.id || !x.channelId),
      );
      let conversation = this.eligibleConversation(
        connection.workspaceId,
        channel.id,
        identity.id,
        now,
      );
      const needsNextResponse = Boolean(
        conversation?.lastAgentMessageAt &&
        (!conversation.lastCustomerMessageAt ||
          conversation.lastAgentMessageAt >=
            conversation.lastCustomerMessageAt),
      );
      if (conversation?.status === "CLOSED") {
        this.reopenSystem(conversation, now);
        this.support.serviceEvent(
          conversation.workspaceId,
          "CONVERSATION_REOPENED",
          "CONVERSATION",
          conversation.id,
          { source: "INBOUND_MESSAGE" },
        );
      }
      if (!conversation) {
        conversation = {
          id: this.store.id(),
          workspaceId: connection.workspaceId,
          channelId: channel.id,
          queueId: queue?.id ?? null,
          status: "WAITING_AGENT",
          customerIdentityId: identity.id,
          primaryContactId: identity.contactId ?? null,
          primaryCompanyId: identity.companyId ?? null,
          primaryDealId: null,
          currentAssigneeUserId: null,
          openedAt: now,
          closedAt: null,
          lastCustomerMessageAt: now,
          lastAgentMessageAt: null,
          reopenUntil: null,
          priority: "NORMAL",
          version: 1,
        };
        this.store.state.customerConversations.push(conversation);
        this.support.serviceEvent(
          conversation.workspaceId,
          "CONVERSATION_CREATED",
          "CONVERSATION",
          conversation.id,
          { channelId: channel.id },
        );
        if (queue) this.routeConversation(conversation, queue, now);
        this.startSla(conversation, "FIRST_RESPONSE", now, queue);
        this.startSla(conversation, "RESOLUTION", now, queue);
      }
      this.resumeSla(conversation.id, event.occurredAt);
      if (
        needsNextResponse &&
        !this.store.state.slaTimers.some(
          (x) =>
            x.conversationId === conversation!.id &&
            x.type === "NEXT_RESPONSE" &&
            !x.satisfiedAt,
        )
      )
        this.startSla(conversation, "NEXT_RESPONSE", event.occurredAt, queue);
      conversation.lastCustomerMessageAt = event.occurredAt;
      conversation.status = conversation.currentAssigneeUserId
        ? "OPEN"
        : "WAITING_AGENT";
      const message = {
        id: this.store.id(),
        workspaceId: connection.workspaceId,
        conversationId: conversation.id,
        connectionId: connection.id,
        direction: "INBOUND" as const,
        senderType: "CUSTOMER" as const,
        senderUserId: null,
        externalMessageId: event.externalMessageId,
        clientMessageId: null,
        messageType: event.messageType ?? "TEXT",
        body: event.text ?? "",
        occurredAt: event.occurredAt,
        deliveryStatus: "DELIVERED" as const,
      };
      this.store.state.conversationMessages.push(message);
      this.store.state.channelProviderEvents.push({
        id: this.store.id(),
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        externalEventId: event.eventId,
        externalMessageId: event.externalMessageId,
        createdAt: now,
      });
      this.support.serviceEvent(
        conversation.workspaceId,
        "MESSAGE_RECEIVED",
        "CONVERSATION",
        conversation.id,
        { messageId: message.id },
      );
      return { duplicate: false, conversation, message, identity };
    });
  }
  async retryOutbound(messageId: string, connectionId: string) {
    const message = this.store.state.conversationMessages.find(
      (x) => x.id === messageId && x.direction === "OUTBOUND",
    );
    const connection = this.store.state.channelConnections.find(
      (x) =>
        x.id === connectionId &&
        x.workspaceId === message?.workspaceId &&
        x.status === "ACTIVE",
    );
    if (!message || !connection)
      throw new AppError(
        "CHANNEL_SEND_FAILED",
        "Outbound message or active connection was not found.",
        404,
      );
    if (["SENT", "DELIVERED", "READ"].includes(message.deliveryStatus ?? ""))
      return message;
    const result = await this.connectors
      .get(connection.providerKey)
      .sendMessage({
        conversationId: message.conversationId,
        localMessageId: message.id,
        text: message.body,
      });
    message.externalMessageId = result.externalMessageId;
    message.deliveryStatus = result.status;
    const conversation = this.conversation(
      message.workspaceId,
      message.conversationId,
    );
    conversation.lastAgentMessageAt = message.occurredAt;
    conversation.status = "WAITING_CUSTOMER";
    this.satisfyResponseSla(conversation, message.occurredAt);
    this.pauseForWaitingCustomer(conversation, message.occurredAt);
    this.support.serviceEvent(
      message.workspaceId,
      "MESSAGE_SENT",
      "CONVERSATION",
      message.conversationId,
      { messageId: message.id },
      message.id,
    );
    return message;
  }
  list(actor: ActorContext) {
    this.support.require(actor, "conversation.read");
    return this.store.state.customerConversations.filter(
      (x) => x.workspaceId === actor.workspaceId && this.canUse(actor, x),
    );
  }
  get(actor: ActorContext, id: string) {
    this.support.require(actor, "conversation.read");
    const c = this.conversation(actor.workspaceId, id);
    if (!this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    return {
      ...c,
      messages: this.store.state.conversationMessages.filter(
        (x) => x.conversationId === c.id,
      ),
      transfers: this.store.state.conversationTransfers.filter(
        (x) => x.conversationId === c.id,
      ),
    };
  }
  async respond(
    actor: ActorContext,
    id: string,
    input: { text: string; clientMessageId: string; aiGenerated?: boolean },
  ) {
    this.support.require(actor, "conversation.respond");
    const c = this.conversation(actor.workspaceId, id);
    if (!this.canRespond(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Caller cannot respond to this conversation.",
        403,
      );
    if (c.status === "CLOSED")
      throw conflict(
        "CONVERSATION_STATE_INVALID",
        "Closed conversation cannot receive outbound messages.",
      );
    if (
      input.aiGenerated &&
      this.access.scopeFor(actor, "conversation.ai_assist") === null
    )
      throw new AppError(
        "PERMISSION_DENIED",
        "AI assist permission is required.",
        403,
      );
    const text = this.support.text(input.text, "text", 10000);
    const existing = this.store.state.conversationMessages.find(
      (x) =>
        x.conversationId === c.id &&
        x.clientMessageId === input.clientMessageId,
    );
    if (existing) {
      if (existing.body !== text)
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "Client message ID was reused with different content.",
        );
      return existing;
    }
    const connection = this.store.state.channelConnections.find(
      (x) =>
        x.workspaceId === actor.workspaceId &&
        x.channelId === c.channelId &&
        x.status === "ACTIVE",
    );
    const message: ConversationMessage = {
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      conversationId: c.id,
      connectionId: connection?.id ?? null,
      direction: "OUTBOUND",
      senderType: "USER",
      senderUserId: actor.user.id,
      externalMessageId: null,
      clientMessageId: input.clientMessageId,
      messageType: "TEXT",
      body: text,
      occurredAt: new Date(),
      deliveryStatus: "QUEUED",
    };
    this.store.state.conversationMessages.push(message);
    this.support.event(actor, "MESSAGE_QUEUED", "CONVERSATION", c.id, {
      messageId: message.id,
    });
    if (!connection) return message;
    try {
      const result = await this.connectors
        .get(connection.providerKey)
        .sendMessage({
          conversationId: c.id,
          localMessageId: message.id,
          text: message.body,
        });
      message.externalMessageId = result.externalMessageId;
      message.deliveryStatus = result.status;
      c.lastAgentMessageAt = message.occurredAt;
      c.status = "WAITING_CUSTOMER";
      this.satisfyResponseSla(c, message.occurredAt);
      this.pauseForWaitingCustomer(c, message.occurredAt);
      this.support.event(actor, "MESSAGE_SENT", "CONVERSATION", c.id, {
        messageId: message.id,
      });
      return message;
    } catch (error) {
      this.store.state.backgroundJobs.push({
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        type: "CHANNEL_SEND",
        key: `message:${message.id}`,
        status: "PENDING",
        attempts: 1,
        maxAttempts: 5,
        runAt: new Date(Date.now() + 1000),
        payload: { messageId: message.id, connectionId: connection.id },
        lastError: (error as Error).message,
      });
      return message;
    }
  }
  assign(
    actor: ActorContext,
    id: string,
    userId: string,
    override = false,
    expectedVersion?: number,
  ) {
    this.support.require(actor, "conversation.assign");
    if (override) this.support.require(actor, "contact_center.queue_manage");
    const c = this.conversation(actor.workspaceId, id);
    if (!override && !this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    if (expectedVersion !== undefined && c.version !== expectedVersion)
      throw conflict(
        "CONCURRENCY_CONFLICT",
        "Conversation changed before assignment.",
      );
    const q = c.queueId ? this.queue(actor.workspaceId, c.queueId) : null;
    if (
      !this.access.isActiveMember(actor.workspaceId, userId) ||
      (!override &&
        q &&
        !this.eligibleMembers(q, new Date()).some((x) => x.userId === userId))
    )
      throw conflict(
        "CONVERSATION_ASSIGNMENT_INVALID",
        "Agent is not eligible.",
      );
    this.endAssignment(c);
    c.currentAssigneeUserId = userId;
    c.status = "OPEN";
    c.version++;
    this.store.state.conversationAssignments.push({
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      conversationId: c.id,
      userId,
      queueId: c.queueId,
      assignedAt: new Date(),
      endedAt: null,
      actorUserId: actor.user.id,
    });
    this.support.audit(
      actor,
      "CONVERSATION.ASSIGNED",
      "Conversation",
      c.id,
      null,
      { userId, override, version: c.version },
    );
    this.support.event(actor, "CONVERSATION_ASSIGNED", "CONVERSATION", c.id, {
      userId,
      version: c.version,
    });
    return c;
  }
  claim(actor: ActorContext, id: string) {
    this.support.require(actor, "conversation.assign");
    const c = this.conversation(actor.workspaceId, id);
    if (c.currentAssigneeUserId)
      throw conflict(
        "CONVERSATION_ALREADY_CLAIMED",
        "Conversation was already claimed.",
      );
    const q = c.queueId ? this.queue(actor.workspaceId, c.queueId) : null;
    if (
      !q ||
      q.routingMode !== "BROADCAST" ||
      !this.eligibleMembers(q, new Date()).some(
        (x) => x.userId === actor.user.id,
      )
    )
      throw conflict(
        "CONVERSATION_ASSIGNMENT_INVALID",
        "Conversation cannot be claimed by caller.",
      );
    return this.assign(actor, id, actor.user.id, false, c.version);
  }
  transfer(
    actor: ActorContext,
    id: string,
    input: {
      toUserId?: string | null;
      toQueueId?: string | null;
      reason?: string;
      expectedVersion?: number;
    },
  ) {
    this.support.require(actor, "conversation.transfer");
    const c = this.conversation(actor.workspaceId, id);
    if (!this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    if (
      input.expectedVersion !== undefined &&
      c.version !== input.expectedVersion
    )
      throw conflict(
        "CONCURRENCY_CONFLICT",
        "Conversation changed before transfer.",
      );
    const beforeUser = c.currentAssigneeUserId,
      beforeQueue = c.queueId;
    const targetQueue = input.toQueueId
      ? this.queue(actor.workspaceId, input.toQueueId)
      : c.queueId
        ? this.queue(actor.workspaceId, c.queueId)
        : null;
    const transferAt = new Date();
    if (input.toUserId) {
      if (!this.access.isActiveMember(actor.workspaceId, input.toUserId))
        throw conflict(
          "CONVERSATION_ASSIGNMENT_INVALID",
          "Transfer target must be an active workspace member.",
        );
      if (
        targetQueue &&
        !this.eligibleMembers(targetQueue, transferAt).some(
          (x) => x.userId === input.toUserId,
        )
      )
        throw conflict(
          "CONVERSATION_ASSIGNMENT_INVALID",
          "Transfer target is not eligible for the queue.",
        );
    }
    this.endAssignment(c);
    c.currentAssigneeUserId = input.toUserId ?? null;
    c.queueId = targetQueue?.id ?? null;
    c.version++;
    this.store.state.conversationTransfers.push({
      id: this.store.id(),
      workspaceId: actor.workspaceId,
      conversationId: c.id,
      fromUserId: beforeUser,
      fromQueueId: beforeQueue,
      toUserId: c.currentAssigneeUserId,
      toQueueId: c.queueId,
      actorUserId: actor.user.id,
      reason: input.reason ?? null,
      createdAt: transferAt,
    });
    if (c.currentAssigneeUserId)
      this.store.state.conversationAssignments.push({
        id: this.store.id(),
        workspaceId: actor.workspaceId,
        conversationId: c.id,
        userId: c.currentAssigneeUserId,
        queueId: c.queueId,
        assignedAt: transferAt,
        endedAt: null,
        actorUserId: actor.user.id,
      });
    else if (targetQueue) this.routeConversation(c, targetQueue, transferAt);
    const policy = targetQueue?.slaPolicyId
      ? this.slaPolicy(c.workspaceId, targetQueue.slaPolicyId)
      : null;
    this.store.state.slaTimers
      .filter((x) => x.conversationId === c.id)
      .forEach((x) => {
        x.history.push({
          type: "TRANSFER",
          at: transferAt.toISOString(),
          fromUserId: beforeUser,
          toUserId: c.currentAssigneeUserId,
          behavior: policy?.transferBehavior ?? "CONTINUE",
        });
        if (policy?.transferBehavior === "RESET" && !x.satisfiedAt) {
          const minutes =
            x.type === "FIRST_RESPONSE"
              ? policy.firstResponseMinutes
              : x.type === "NEXT_RESPONSE"
                ? policy.nextResponseMinutes
                : policy.resolutionMinutes;
          x.startedAt = transferAt;
          x.dueAt = this.businessDue(
            transferAt,
            minutes,
            targetQueue?.workCalendar,
          );
          x.pausedAt = null;
          x.pausedMs = 0;
          x.breachedAt = null;
          x.escalationEmitted = false;
          x.policyVersion = policy.version;
        }
      });
    this.support.audit(
      actor,
      "CONVERSATION.TRANSFERRED",
      "Conversation",
      c.id,
      null,
      {
        fromUserId: beforeUser,
        toUserId: c.currentAssigneeUserId,
        fromQueueId: beforeQueue,
        toQueueId: c.queueId,
        reason: input.reason,
        slaTransferBehavior: policy?.transferBehavior ?? "CONTINUE",
      },
    );
    this.support.event(actor, "CONVERSATION_TRANSFERRED", "CONVERSATION", c.id);
    return c;
  }
  close(actor: ActorContext, id: string, now = new Date()) {
    this.support.require(actor, "conversation.close");
    const c = this.conversation(actor.workspaceId, id),
      q = c.queueId ? this.queue(actor.workspaceId, c.queueId) : null;
    if (!this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    c.status = "CLOSED";
    c.closedAt = now;
    c.reopenUntil = new Date(
      now.getTime() + (q?.reopenWindowMinutes ?? 0) * 60000,
    );
    this.store.state.slaTimers
      .filter(
        (x) =>
          x.conversationId === c.id &&
          x.type === "RESOLUTION" &&
          !x.satisfiedAt,
      )
      .forEach((x) => (x.satisfiedAt = now));
    this.support.audit(actor, "CONVERSATION.CLOSED", "Conversation", c.id, null, {
      closedAt: now,
      reopenUntil: c.reopenUntil,
    });
    this.support.event(actor, "CONVERSATION_CLOSED", "CONVERSATION", c.id);
    return c;
  }
  reopen(actor: ActorContext, id: string, now = new Date()) {
    this.support.require(actor, "conversation.reopen");
    const c = this.conversation(actor.workspaceId, id);
    if (!this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    this.reopenSystem(c, now);
    this.support.audit(actor, "CONVERSATION.REOPENED", "Conversation", c.id, null, {
      reopenedAt: now,
    });
    this.support.event(actor, "CONVERSATION_REOPENED", "CONVERSATION", c.id);
    return c;
  }
  bindCrm(
    actor: ActorContext,
    id: string,
    input: {
      contactId?: string | null;
      companyId?: string | null;
      dealId?: string | null;
    },
  ) {
    this.support.require(actor, "conversation.bind_crm");
    const c = this.conversation(actor.workspaceId, id);
    if (!this.canUse(actor, c))
      throw new AppError(
        "PERMISSION_DENIED",
        "Conversation is outside caller scope.",
        403,
      );
    if (
      input.contactId &&
      !this.store.state.crmContacts.some(
        (x) =>
          x.id === input.contactId &&
          x.workspaceId === actor.workspaceId &&
          !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Contact was not found.",
        404,
      );
    if (
      input.companyId &&
      !this.store.state.crmCompanies.some(
        (x) =>
          x.id === input.companyId &&
          x.workspaceId === actor.workspaceId &&
          !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Company was not found.",
        404,
      );
    if (
      input.dealId &&
      !this.store.state.crmDeals.some(
        (x) =>
          x.id === input.dealId &&
          x.workspaceId === actor.workspaceId &&
          !x.isDeleted,
      )
    )
      throw new AppError(
        "CROSS_WORKSPACE_REFERENCE",
        "Deal was not found.",
        404,
      );
    c.primaryContactId = input.contactId ?? null;
    c.primaryCompanyId = input.companyId ?? null;
    c.primaryDealId = input.dealId ?? null;
    const identity = this.store.state.customerChannelIdentities.find(
      (x) => x.id === c.customerIdentityId,
    )!;
    identity.contactId = c.primaryContactId;
    identity.companyId = c.primaryCompanyId;
    identity.ambiguous = false;
    this.support.audit(
      actor,
      "CONVERSATION.CRM_BOUND",
      "Conversation",
      c.id,
      null,
      input,
    );
    this.support.event(
      actor,
      "CONVERSATION_CRM_BOUND",
      "CONVERSATION",
      c.id,
      input,
    );
    return c;
  }

  checkSla(now = new Date()) {
    const breached = [];
    for (const t of this.store.state.slaTimers) {
      if (!t.satisfiedAt && !t.breachedAt && !t.pausedAt && t.dueAt <= now) {
        t.breachedAt = now;
        if (!t.escalationEmitted) {
          t.escalationEmitted = true;
          this.support.serviceEvent(
            t.workspaceId,
            "SLA_BREACHED",
            "CONVERSATION",
            t.conversationId,
            { timerId: t.id, type: t.type },
            t.id,
          );
        }
        breached.push(t);
      }
    }
    return breached;
  }
  pauseSla(conversationId: string, now = new Date()) {
    const conversation = this.store.state.customerConversations.find(
        (x) => x.id === conversationId,
      ),
      queue = conversation?.queueId
        ? this.store.state.contactCenterQueues.find(
            (x) =>
              x.id === conversation.queueId &&
              x.workspaceId === conversation.workspaceId,
          )
        : undefined;
    for (const t of this.store.state.slaTimers.filter(
      (x) =>
        x.conversationId === conversationId && !x.satisfiedAt && !x.pausedAt,
    )) {
      t.remainingBusinessMinutes = this.businessMinutesBetween(
        now,
        t.dueAt,
        queue?.workCalendar,
      );
      t.pausedAt = now;
    }
  }
  resumeSla(conversationId: string, now = new Date()) {
    const conversation = this.store.state.customerConversations.find(
        (x) => x.id === conversationId,
      ),
      queue = conversation?.queueId
        ? this.store.state.contactCenterQueues.find(
            (x) =>
              x.id === conversation.queueId &&
              x.workspaceId === conversation.workspaceId,
          )
        : undefined;
    for (const t of this.store.state.slaTimers.filter(
      (x) =>
        x.conversationId === conversationId && !x.satisfiedAt && x.pausedAt,
    )) {
      const ms = now.getTime() - t.pausedAt!.getTime();
      t.pausedMs += ms;
      t.dueAt = this.businessDue(
        now,
        t.remainingBusinessMinutes ?? 0,
        queue?.workCalendar,
      );
      t.remainingBusinessMinutes = null;
      t.pausedAt = null;
    }
  }
  businessDue(start: Date, businessMinutes: number, calendar?: WorkCalendar) {
    if (!calendar) return new Date(start.getTime() + businessMinutes * 60000);
    let remaining = businessMinutes,
      current = new Date(start);
    while (remaining > 0) {
      const local = this.parts(current, calendar.timezone);
      const date = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
      const working =
        calendar.workingDays.includes(local.weekday) &&
        !calendar.holidays.includes(date);
      if (
        working &&
        local.hour >= calendar.startHour &&
        local.hour < calendar.endHour
      )
        remaining--;
      current = new Date(current.getTime() + 60000);
    }
    return current;
  }
  private businessMinutesBetween(
    start: Date,
    end: Date,
    calendar?: WorkCalendar,
  ) {
    if (end <= start) return 0;
    if (!calendar) return Math.ceil((end.getTime() - start.getTime()) / 60000);
    let minutes = 0,
      current = new Date(start);
    while (current < end) {
      const local = this.parts(current, calendar.timezone),
        date = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
      if (
        calendar.workingDays.includes(local.weekday) &&
        !calendar.holidays.includes(date) &&
        local.hour >= calendar.startHour &&
        local.hour < calendar.endHour
      )
        minutes++;
      current = new Date(current.getTime() + 60000);
    }
    return minutes;
  }

  private resolveIdentity(
    connection: { id: string; workspaceId: string },
    value: string,
  ) {
    const normalized = value.includes("@")
      ? value.trim().toLowerCase()
      : value.replace(/\D/g, "");
    let identity = this.store.state.customerChannelIdentities.find(
      (x) =>
        x.workspaceId === connection.workspaceId &&
        x.connectionId === connection.id &&
        x.normalizedValue === normalized,
    );
    if (identity) return identity;
    const matches = (candidate: string) =>
      candidate === normalized || candidate.replace(/\D/g, "") === normalized;
    const contactIds = new Set<string>(),
      companyIds = new Set<string>();
    for (const c of this.store.state.crmContactCommunications)
      if (
        c.workspaceId === connection.workspaceId &&
        matches(c.normalizedValue)
      )
        contactIds.add(c.contactId);
    for (const c of this.store.state.crmCompanyCommunications)
      if (
        c.workspaceId === connection.workspaceId &&
        matches(c.normalizedValue)
      )
        companyIds.add(c.companyId);
    let contactId = contactIds.size === 1 ? [...contactIds][0] : null,
      companyId = companyIds.size === 1 ? [...companyIds][0] : null,
      ambiguous = contactIds.size > 1 || companyIds.size > 1;
    if (contactIds.size && companyIds.size) {
      const pairs = this.store.state.crmContactCompanies.filter(
        (x) =>
          x.workspaceId === connection.workspaceId &&
          contactIds.has(x.contactId) &&
          companyIds.has(x.companyId),
      );
      const uniquePairs = [
        ...new Map(
          pairs.map((x) => [`${x.contactId}:${x.companyId}`, x]),
        ).values(),
      ];
      if (uniquePairs.length === 1) {
        contactId = uniquePairs[0].contactId;
        companyId = uniquePairs[0].companyId;
        ambiguous = false;
      } else if (!(
        contactIds.size === 1 &&
        companyIds.size === 1 &&
        uniquePairs.length === 1
      )) {
        contactId = null;
        companyId = null;
        ambiguous = true;
      }
    }
    identity = {
      id: this.store.id(),
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      kind: value.includes("@") ? "EMAIL" : "PHONE",
      normalizedValue: normalized,
      contactId,
      companyId,
      ambiguous,
    };
    this.store.state.customerChannelIdentities.push(identity);
    return identity;
  }
  private applyUnknownCustomerPolicy(
    channel: Channel,
    identity: { id: string; contactId?: string | null },
    externalIdentity: string,
  ) {
    if (
      channel.unknownCustomerPolicy === "KEEP_UNLINKED" ||
      channel.unknownCustomerPolicy === "REQUIRE_AGENT_CONFIRMATION"
    )
      return;
    const user = this.store.state.users.find(
      (x) => x.id === channel.serviceUserId && !x.isDeleted,
    );
    if (!user || !this.access.isActiveMember(channel.workspaceId, user.id))
      throw conflict(
        "CHANNEL_CONFIGURATION_INVALID",
        "Channel service user is unavailable.",
      );
    const communication = {
      type: (externalIdentity.includes("@") ? "EMAIL" : "PHONE") as
        "EMAIL" | "PHONE",
      value: externalIdentity,
    };
    if (channel.unknownCustomerPolicy === "CREATE_CONTACT") {
      if (!this.crmCore)
        throw conflict(
          "CHANNEL_CONFIGURATION_INVALID",
          "CRM contact service is unavailable.",
        );
      const contact = this.crmCore.createContact(user, channel.workspaceId, {
        firstName: "Channel",
        lastName: "Customer",
        responsibleUserId: user.id,
        communications: [communication],
        forceCreate: true,
      });
      identity.contactId = contact.id;
      this.support.serviceEvent(
        channel.workspaceId,
        "CONTACT_CENTER_CUSTOMER_CREATED",
        "CONTACT",
        contact.id,
        { channelId: channel.id },
      );
      return;
    }
    if (!this.crm)
      throw conflict(
        "CHANNEL_CONFIGURATION_INVALID",
        "CRM lead service is unavailable.",
      );
    const lead = this.crm.createLead(
      user,
      channel.workspaceId,
      {
        title: `Inbound ${channel.name}`,
        responsibleUserId: user.id,
        communications: [communication],
        forceCreate: true,
        originSystem: "CONTACT_CENTER",
        originExternalId: identity.id,
      },
      `channel:${channel.id}:${identity.id}`,
    );
    this.support.serviceEvent(
      channel.workspaceId,
      "CONTACT_CENTER_LEAD_CREATED",
      "LEAD",
      lead.id,
      { channelId: channel.id, identityId: identity.id },
    );
  }
  private eligibleConversation(
    workspaceId: string,
    channelId: string,
    identityId: string,
    now: Date,
  ) {
    return this.store.state.customerConversations
      .filter(
        (x) =>
          x.workspaceId === workspaceId &&
          x.channelId === channelId &&
          x.customerIdentityId === identityId,
      )
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .find(
        (x) =>
          x.status !== "CLOSED" ||
          (x.reopenUntil?.getTime() ?? 0) >= now.getTime(),
      );
  }
  private routeConversation(c: Conversation, q: ContactQueue, now: Date) {
    const eligible = this.eligibleMembers(q, now);
    let member: QueueMember | undefined;
    if (q.routingMode === "FIXED")
      member =
        eligible.find((x) => x.userId === q.fixedUserId) ??
        this.leastLoaded(eligible);
    else if (q.routingMode === "ROUND_ROBIN" && eligible.length) {
      member = eligible[q.roundRobinCursor % eligible.length];
      q.roundRobinCursor = (q.roundRobinCursor + 1) % eligible.length;
    } else if (q.routingMode === "LEAST_LOADED")
      member = this.leastLoaded(eligible);
    else if (q.routingMode === "RULE_BASED") {
      const rule = [...(q.routingRules ?? [])]
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
        .find((x) => this.ruleMatches(x, c));
      member =
        (rule?.targetUserId
          ? eligible.find((x) => x.userId === rule.targetUserId)
          : undefined) ?? this.leastLoaded(eligible);
    } else if (q.routingMode === "CUSTOMER_OWNER") {
      const identity = this.store.state.customerChannelIdentities.find(
        (x) => x.id === c.customerIdentityId,
      );
      const contact = identity?.contactId
        ? this.store.state.crmContacts.find(
            (x) =>
              x.id === identity.contactId &&
              x.workspaceId === c.workspaceId &&
              !x.isDeleted,
          )
        : undefined;
      const company = identity?.companyId
        ? this.store.state.crmCompanies.find(
            (x) =>
              x.id === identity.companyId &&
              x.workspaceId === c.workspaceId &&
              !x.isDeleted,
          )
        : undefined;
      const ownerId = contact?.responsibleUserId ?? company?.responsibleUserId;
      member =
        eligible.find((x) => x.userId === ownerId) ??
        this.leastLoaded(eligible);
    }
    if (member) {
      c.currentAssigneeUserId = member.userId;
      c.status = "OPEN";
      this.store.state.conversationAssignments.push({
        id: this.store.id(),
        workspaceId: c.workspaceId,
        conversationId: c.id,
        userId: member.userId,
        queueId: q.id,
        assignedAt: now,
        endedAt: null,
        actorUserId: null,
      });
      this.support.serviceEvent(
        c.workspaceId,
        "CONVERSATION_ASSIGNED",
        "CONVERSATION",
        c.id,
        { userId: member.userId },
      );
    }
  }
  private eligibleMembers(q: ContactQueue, now: Date) {
    const configured = [
      ...this.store.state.contactCenterQueueMembers.filter(
        (m) => m.queueId === q.id,
      ),
    ];
    const departmentUsers = this.store.state.departmentMembers
      .filter(
        (x) =>
          x.workspaceId === q.workspaceId &&
          !x.isDeleted &&
          (q.departmentIds ?? []).includes(x.departmentId),
      )
      .map((x) => x.userId);
    for (const userId of departmentUsers)
      if (!configured.some((x) => x.userId === userId))
        configured.push({
          id: `department:${q.id}:${userId}`,
          workspaceId: q.workspaceId,
          queueId: q.id,
          userId,
          order: Number.MAX_SAFE_INTEGER,
          capacityOverride: null,
          active: true,
          available: true,
          absent: false,
        });
    return configured
      .filter(
        (m) =>
          m.active &&
          m.available &&
          !m.absent &&
          this.access.isActiveMember(q.workspaceId, m.userId) &&
          this.agentHasPermission(
            q.workspaceId,
            m.userId,
            "conversation.read",
          ) &&
          this.agentHasPermission(
            q.workspaceId,
            m.userId,
            "conversation.respond",
          ) &&
          this.withinCalendar(now, q.workCalendar) &&
          this.load(m.userId) <
            (m.capacityOverride ??
              q.maxConcurrentPerAgent ??
              Number.MAX_SAFE_INTEGER),
      )
      .sort((a, b) => a.order - b.order || a.userId.localeCompare(b.userId));
  }
  private leastLoaded(members: QueueMember[]) {
    return [...members].sort(
      (a, b) =>
        this.load(a.userId) - this.load(b.userId) ||
        a.order - b.order ||
        a.userId.localeCompare(b.userId),
    )[0];
  }
  private agentHasPermission(workspaceId: string, userId: string, key: string) {
    const membership = this.store.state.workspaceMemberships.find(
      (x) =>
        x.workspaceId === workspaceId &&
        x.userId === userId &&
        x.status === "ACTIVE" &&
        !x.isDeleted,
    );
    if (!membership) return false;
    const role = this.store.state.roles.find(
      (x) => x.id === membership.roleId && !x.isDeleted,
    );
    if (role?.isOwnerRole) return true;
    return this.store.state.rolePermissions.some(
      (rp) =>
        rp.roleId === role?.id &&
        !rp.isDeleted &&
        this.store.state.permissions.some(
          (p) => p.id === rp.permissionId && p.key === key && !p.isDeleted,
        ),
    );
  }
  private load(userId: string) {
    return this.store.state.customerConversations.filter(
      (x) => x.currentAssigneeUserId === userId && x.status !== "CLOSED",
    ).length;
  }
  private withinCalendar(now: Date, cal?: WorkCalendar) {
    if (!cal) return true;
    const p = this.parts(now, cal.timezone);
    return (
      cal.workingDays.includes(p.weekday) &&
      p.hour >= cal.startHour &&
      p.hour < cal.endHour &&
      !cal.holidays.includes(`${p.year}-${pad(p.month)}-${pad(p.day)}`)
    );
  }
  private startSla(
    c: Conversation,
    type: SlaTimer["type"],
    now: Date,
    q?: ContactQueue,
  ) {
    const policy = q?.slaPolicyId
      ? this.slaPolicy(c.workspaceId, q.slaPolicyId)
      : null;
    const minutes = policy
      ? type === "FIRST_RESPONSE"
        ? policy.firstResponseMinutes
        : type === "NEXT_RESPONSE"
          ? policy.nextResponseMinutes
          : policy.resolutionMinutes
      : type === "RESOLUTION"
        ? 480
        : 60;
    const due = this.businessDue(now, minutes, q?.workCalendar);
    this.store.state.slaTimers.push({
      id: this.store.id(),
      workspaceId: c.workspaceId,
      conversationId: c.id,
      type,
      policyVersion: policy?.version ?? 1,
      startedAt: now,
      dueAt: due,
      pausedAt: null,
      pausedMs: 0,
      satisfiedAt: null,
      breachedAt: null,
      escalationEmitted: false,
      history: [],
    });
  }
  private satisfyResponseSla(c: Conversation, now: Date) {
    this.store.state.slaTimers
      .filter(
        (x) =>
          x.conversationId === c.id &&
          (x.type === "FIRST_RESPONSE" || x.type === "NEXT_RESPONSE") &&
          !x.satisfiedAt,
      )
      .forEach((x) => (x.satisfiedAt = now));
  }
  private pauseForWaitingCustomer(c: Conversation, now: Date) {
    const q = c.queueId ? this.queue(c.workspaceId, c.queueId) : null;
    const policy = q?.slaPolicyId
      ? this.slaPolicy(c.workspaceId, q.slaPolicyId)
      : null;
    if (policy?.pauseOnWaitingCustomer) this.pauseSla(c.id, now);
  }
  private applyDelivery(
    workspaceId: string,
    connectionId: string,
    event: NormalizedChannelEvent,
    supported: string[],
  ) {
    const m = this.store.state.conversationMessages.find(
      (x) =>
        x.workspaceId === workspaceId &&
        x.connectionId === connectionId &&
        x.externalMessageId === event.externalMessageId,
    );
    if (!m) return { ignored: true };
    if (event.eventType === "MESSAGE" || !supported.includes(event.eventType))
      return { ignored: true, message: m };
    const state = event.eventType;
    m.deliveryStatus = state;
    this.support.serviceEvent(
      workspaceId,
      `MESSAGE_${state}`,
      "CONVERSATION",
      m.conversationId,
      { messageId: m.id },
    );
    return { ignored: false, message: m };
  }
  private canUse(actor: ActorContext, c: Conversation) {
    if (this.access.scopeFor(actor, "contact_center.queue_manage") !== null)
      return true;
    if (c.currentAssigneeUserId === actor.user.id) return true;
    if (!c.queueId) return false;
    return this.store.state.contactCenterQueueMembers.some(
      (x) => x.queueId === c.queueId && x.userId === actor.user.id && x.active,
    );
  }
  private canRespond(actor: ActorContext, c: Conversation) {
    return (
      c.currentAssigneeUserId === actor.user.id ||
      (!c.currentAssigneeUserId && this.canUse(actor, c))
    );
  }
  private endAssignment(c: Conversation) {
    const a = [...this.store.state.conversationAssignments]
      .reverse()
      .find((x) => x.conversationId === c.id && !x.endedAt);
    if (a) a.endedAt = new Date();
  }
  private reopenSystem(c: Conversation, now: Date) {
    c.status = c.currentAssigneeUserId ? "OPEN" : "WAITING_AGENT";
    c.closedAt = null;
    c.reopenUntil = null;
    c.version++;
    this.store.state.slaTimers
      .filter((x) => x.conversationId === c.id)
      .forEach((x) =>
        x.history.push({ type: "REOPEN", at: now.toISOString() }),
      );
  }
  private channel(workspaceId: string, id: string) {
    const x = this.store.state.communicationChannels.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!x)
      throw new AppError("CHANNEL_NOT_FOUND", "Channel was not found.", 404);
    return x;
  }
  private queue(workspaceId: string, id: string) {
    const x = this.store.state.contactCenterQueues.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!x) throw new AppError("QUEUE_NOT_FOUND", "Queue was not found.", 404);
    return x;
  }
  private slaPolicy(workspaceId: string, id: string) {
    const x = this.store.state.slaPolicies.find(
      (x) => x.id === id && x.workspaceId === workspaceId && x.active,
    );
    if (!x)
      throw new AppError(
        "SLA_POLICY_NOT_FOUND",
        "SLA policy was not found.",
        404,
      );
    return x;
  }
  private validateSlaPolicy(
    input: Pick<
      SlaPolicy,
      "firstResponseMinutes" | "nextResponseMinutes" | "resolutionMinutes"
    > & { transferBehavior?: SlaPolicy["transferBehavior"] },
  ) {
    for (const value of [
      input.firstResponseMinutes,
      input.nextResponseMinutes,
      input.resolutionMinutes,
    ])
      if (!Number.isInteger(value) || value < 1 || value > 525600)
        throw conflict(
          "SLA_POLICY_INVALID",
          "SLA durations must be positive whole minutes.",
        );
    if (
      input.transferBehavior &&
      !["CONTINUE", "RESET"].includes(input.transferBehavior)
    )
      throw conflict("SLA_POLICY_INVALID", "SLA transfer behavior is invalid.");
  }
  private validateQueueConfig(
    workspaceId: string,
    input: Partial<ContactQueue>,
  ) {
    if (
      input.routingMode &&
      ![
        "FIXED",
        "ROUND_ROBIN",
        "LEAST_LOADED",
        "BROADCAST",
        "CUSTOMER_OWNER",
        "RULE_BASED",
      ].includes(input.routingMode)
    )
      throw conflict("QUEUE_CONFIGURATION_INVALID", "Routing mode is invalid.");
    if (
      input.fixedUserId &&
      !this.access.isActiveMember(workspaceId, input.fixedUserId)
    )
      throw conflict(
        "CONVERSATION_ASSIGNMENT_INVALID",
        "Fixed agent must be active.",
      );
    if (
      input.maxConcurrentPerAgent !== undefined &&
      input.maxConcurrentPerAgent !== null &&
      (!Number.isInteger(input.maxConcurrentPerAgent) ||
        input.maxConcurrentPerAgent < 1)
    )
      throw conflict(
        "QUEUE_CONFIGURATION_INVALID",
        "Capacity must be a positive whole number.",
      );
    if (
      input.reopenWindowMinutes !== undefined &&
      (!Number.isInteger(input.reopenWindowMinutes) ||
        input.reopenWindowMinutes < 0)
    )
      throw conflict(
        "QUEUE_CONFIGURATION_INVALID",
        "Reopen window must be a non-negative whole number.",
      );
    if (input.workCalendar) {
      const cal = input.workCalendar;
      try {
        Intl.DateTimeFormat("en", { timeZone: cal.timezone }).format(
          new Date(),
        );
      } catch {
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "Work calendar timezone is invalid.",
        );
      }
      if (
        !Array.isArray(cal.workingDays) ||
        new Set(cal.workingDays).size !== cal.workingDays.length ||
        cal.workingDays.some((x) => !Number.isInteger(x) || x < 0 || x > 6) ||
        !Number.isInteger(cal.startHour) ||
        !Number.isInteger(cal.endHour) ||
        cal.startHour < 0 ||
        cal.endHour > 24 ||
        cal.startHour >= cal.endHour ||
        !Array.isArray(cal.holidays) ||
        cal.holidays.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x))
      )
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "Work calendar is invalid.",
        );
    }
    for (const id of input.departmentIds ?? [])
      if (
        !this.store.state.departments.some(
          (x) => x.id === id && x.workspaceId === workspaceId && !x.isDeleted,
        )
      )
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "Queue department must belong to the workspace.",
        );
    const ids = new Set<string>();
    for (const rule of input.routingRules ?? []) {
      if (
        !rule.id ||
        ids.has(rule.id) ||
        !Number.isInteger(rule.priority) ||
        !["priority", "channelId", "contactId", "companyId"].includes(
          rule.field,
        ) ||
        !["EQ", "IN"].includes(rule.operator)
      )
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "Routing rule is invalid.",
        );
      ids.add(rule.id);
      if (rule.operator === "IN" && !Array.isArray(rule.value))
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "IN routing rule requires an array value.",
        );
      if (
        rule.targetUserId &&
        !this.access.isActiveMember(workspaceId, rule.targetUserId)
      )
        throw conflict(
          "QUEUE_CONFIGURATION_INVALID",
          "Routing rule target must be an active workspace member.",
        );
    }
  }
  private ruleMatches(
    rule: NonNullable<ContactQueue["routingRules"]>[number],
    conversation: Conversation,
  ) {
    const actual =
      rule.field === "priority"
        ? conversation.priority
        : rule.field === "channelId"
          ? conversation.channelId
          : rule.field === "contactId"
            ? (conversation.primaryContactId ?? "")
            : (conversation.primaryCompanyId ?? "");
    return rule.operator === "EQ"
      ? actual === rule.value
      : Array.isArray(rule.value) && rule.value.includes(actual);
  }
  private conversation(workspaceId: string, id: string) {
    const x = this.store.state.customerConversations.find(
      (x) => x.id === id && x.workspaceId === workspaceId,
    );
    if (!x)
      throw new AppError(
        "CONVERSATION_NOT_FOUND",
        "Conversation was not found.",
        404,
      );
    return x;
  }
  private safeConnection<T extends { secretReference?: string | null }>(x: T) {
    return { ...x, secretReference: x.secretReference ? "[REDACTED]" : null };
  }
  private parts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    return {
      year: Number(get("year")),
      month: Number(get("month")),
      day: Number(get("day")),
      hour: Number(get("hour")),
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
        get("weekday"),
      ),
    };
  }
}
function pad(n: number) {
  return String(n).padStart(2, "0");
}
