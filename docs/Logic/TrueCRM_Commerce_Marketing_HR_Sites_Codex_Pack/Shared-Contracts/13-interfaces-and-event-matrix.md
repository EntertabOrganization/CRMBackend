# Cross-module service interfaces and event matrix

| Calling module | Owning system and command/query | Payload expectation | Failure handling |
|---|---|---|---|
| Commerce | Catalog `resolveListingPrice(productId,variantId,currency,storeId,asOf)` | Workspace-qualified exact money/unit/variant/tax category snapshot | Invalid listing/price blocks checkout |
| Commerce | Inventory `reserve(workspaceId,orderLineId,variantId,warehouseId,qty,expiresAt,key)` | Reservation ID/qty/status; no movement until fulfillment | Retry/reconcile; no fake reservation/backorder |
| Commerce | Inventory `issue(reservationId,fulfilledQty,key)`, `release(reservationId,qty,key)`, `restock(returnLineId,qty,key)` | Append-only movement/reference, available qty | Retry with business key and alert if movement unknown |
| Commerce | Payments `createAttempt(orderId,amount,currency,provider,key)` and `verifyAndAllocate(providerEvent)` | Trusted capture/refund ledger reference and outcome | Inbox/reconcile; never infer paid from redirect |
| Commerce | CRM `matchOrCreateCustomer(identity,policy,key)` and `createDealIfConfigured(orderId,key)` | CRM Contact/Company/Deal IDs only; record relation in Commerce | Order stays committed; outbox retry and visible failure |
| Commerce | Contact Center `issuePaymentLink(conversationId,customerScope,key)` | Signed short-lived checkout link with matching agent permission | Link not issued if unauthorized/unavailable |
| Marketing | CRM `queryEligibleContacts(segmentRuleVersion,workspaceScope)` | Scoped normalized destinations/identity references | Fail audience snapshot; no cross-tenant lists |
| Marketing | Communication provider `send(channel,senderId,destination,content,key)` | Accepted/failed/unknown with provider ref | Verify status before retry; no duplicate cross-channel send |
| Marketing | Workflow `startPublishedJourney(definitionVersion,subject,eventId)` | Execution ID with pinned version | Retry idempotently, never second workflow engine |
| Marketing | Sales Intelligence `importAdMetrics(period,provider,amounts)` and `attributeConversions(campaignId)` | Metric revision, model/version/time basis | Lag visible; does not rewrite delivery history |
| HR | Workspace Membership `revokeMember(workspaceId,userId,effectiveAt,key)` | Workspace-only access state | Lifecycle remains incomplete/retryable on failure |
| HR | Calendar `publishAbsenceFreeBusy(employeeId,ranges,eventId)` | Availability-only projection, no private reasons | Retry; HR source leave remains approved |
| HR | Workflow `startLeaveApproval(requestId,policyVersion,actor)` | Version-pinned human approval steps | Retry/reconcile, no implicit HR approval |
| HR | Tasks `linkWorkReportTasks(reportId,taskIds)` | IDs only; Task visibility rechecked on read | Reject hidden Task references |
| Sites | Forms `getPublishedEmbed(formId)` and `submit(formId,payload,publicContext,key)` | Form-owned schema and receipt status | Show error; no false successful submission |
| Sites | Commerce `getPublicListing(storeId,productId)` and `checkout(checkoutSessionId,key)` | Public product info and real checkout status | Site remains up; disable affected block honestly |
| Sites | Contact Center `getPublicWidget(channelId,host)` | Approved widget config only | Controlled block unavailable state |
| Sites | Files `getSafePublicDerivative(fileId,releaseId)` | Scan-cleared asset and expiring/cached URL | Block compile fails or safe placeholder |
| Sites | AI `runScenario(siteDraft,authorizedContext,scope,quota)` | Validated structured block draft with token/cost | Draft only, no publish, explicit error |
| All | Subscription `resolveEffectiveEntitlement(workspaceId,capability,at)` | Feature allowed+limit+usage+grace/policy version | Deny new premium action, preserve obligations |
| All | Platform Outbox/Audit `record(stateChange,event,actor)` | Same DB transaction where possible | No successful mutation without durable audit/outbox |

Cross-module integration results require `externalReference`, `idempotencyKey`, `sourceVersion`, `correlationId`, `workspaceId`, and redacted status. Version and timestamp schema documented in `05-transactions-and-events.md`. Never call the owner's PostgreSQL tables from another module's service. Failure/retry semantics follow `04-domain-workflows-and-states.md`.
