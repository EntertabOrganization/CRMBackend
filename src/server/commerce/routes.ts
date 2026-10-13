import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { CommerceStoreService } from './store-service';
import { CommercePublicationService } from './publication-service';
import { CommercePricingPolicyService } from './pricing-policy-service';
import { CommerceCartService } from './cart-service';
import { CommerceCheckoutService } from './checkout-service';
import { CommerceOrderService } from './order-service';
import { CommerceShipmentService } from './shipment-service';
import { CommerceDeliveryCallbackService } from './delivery-callback-service';
import { CommercePaymentQueryService } from './payment-query-service';
import { CommercePaymentCommandService } from './payment-command-service';
import { CommercePaymentCallbackService } from './payment-callback-service';
import { CommercePaymentDisputeService } from './payment-dispute-service';
import { CommerceIntegrationInspectionService } from './integration-inspection-service';
import { CommerceReconciliationService } from './reconciliation-service';
import { CommerceCrmSyncService } from './crm-sync-service';
import { CommerceCustomerService } from './customer-service';
import { CommerceReturnService } from './return-service';
import { CommerceRefundService } from './refund-service';
export const commerceStores = new CommerceStoreService(prisma);
export const commercePublications = new CommercePublicationService(prisma,commerceStores);
export const commercePricingPolicies = new CommercePricingPolicyService(prisma,commerceStores);
export const commerceCarts = new CommerceCartService(prisma,commercePublications);
export const commerceCheckout = new CommerceCheckoutService(prisma,commerceCarts);
export const commerceOrders = new CommerceOrderService(prisma,commerceStores);
export const commerceShipments = new CommerceShipmentService(prisma,commerceOrders);
export const commerceDeliveryCallbacks = new CommerceDeliveryCallbackService(prisma,commerceShipments);
export const commercePayments = new CommercePaymentQueryService(prisma,commerceOrders);
export const commercePaymentCommands = new CommercePaymentCommandService(prisma,commerceOrders);
export const commercePaymentCallbacks = new CommercePaymentCallbackService(prisma,commerceOrders);
export const commercePaymentDisputes = new CommercePaymentDisputeService(prisma,commerceOrders);
export const commerceIntegrationInspection = new CommerceIntegrationInspectionService(prisma,commerceOrders);
export const commerceReconciliation = new CommerceReconciliationService(prisma,commerceOrders,commerceIntegrationInspection);
export const commerceCrmSync = new CommerceCrmSyncService(prisma,commerceOrders);
export const commerceCustomers = new CommerceCustomerService(prisma,commerceStores,commercePublications);
export const commerceReturns = new CommerceReturnService(prisma,commerceOrders);
export const commerceRefunds = new CommerceRefundService(prisma,commerceOrders);
export const commerceRouter = new PackRouter()
  .add('POST','/api/v1/commerce/orders/:orderId/refunds','CommerceRefundsController',c=>commerceRefunds.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),201)
  .add('GET','/api/v1/commerce/refunds/:refundId','CommerceRefundsController',c=>commerceRefunds.get(c.actor,c.params.refundId))
  .add('POST','/api/v1/commerce/refunds/:refundId/approve','CommerceRefundsController',c=>commerceRefunds.approve(c.actor,c.params.refundId,c.body))
  .add('POST','/api/v1/commerce/refunds/:refundId/process','CommerceRefundsController',c=>commerceRefunds.process(c.actor,c.params.refundId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('POST','/api/v1/commerce/orders/:orderId/returns','CommerceReturnsController',c=>commerceReturns.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),201)
  .add('GET','/api/v1/commerce/returns','CommerceReturnsController',c=>commerceReturns.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/returns/:returnId','CommerceReturnsController',c=>commerceReturns.get(c.actor,c.params.returnId))
  .add('POST','/api/v1/commerce/returns/:returnId/approve','CommerceReturnsController',c=>commerceReturns.approve(c.actor,c.params.returnId,c.body))
  .add('POST','/api/v1/commerce/returns/:returnId/receive','CommerceReturnsController',c=>commerceReturns.receive(c.actor,c.params.returnId,c.body,c.request.headers.get('idempotency-key')))
  .add('POST','/api/v1/commerce/returns/:returnId/inspect','CommerceReturnsController',c=>commerceReturns.inspect(c.actor,c.params.returnId,c.body,c.request.headers.get('idempotency-key')))
  .add('GET','/api/v1/commerce/customers','CommerceCustomersController',c=>commerceCustomers.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/customers/:customerId/orders','CommerceOrdersController',c=>commerceCustomers.orders(c.actor,c.params.customerId,c.query))
  .add('POST','/api/v1/commerce/customers/:customerId/crm-link','CommerceCustomersController',c=>commerceCustomers.link(c.actor,c.params.customerId,c.body))
  .addPublic('GET','/api/v1/storefront/:storeSlug/account/orders','CommerceCustomersController',c=>commerceCustomers.ownOrders(c.params.storeSlug,c.request.headers.get('authorization'),c.query))
  .addPublic('POST','/api/v1/storefront/:storeSlug/orders/:orderId/reorder','CommerceOrdersController',c=>commerceCustomers.reorder(c.params.storeSlug,c.params.orderId,c.request.headers.get('authorization'),c.body),201)
  .add('POST','/api/v1/commerce/orders/:orderId/crm-sync','CommerceIntegrationsController',c=>commerceCrmSync.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/commerce/orders/:orderId/integrations','CommerceIntegrationsController',c=>commerceIntegrationInspection.integrations(c.actor,c.params.orderId))
  .add('POST','/api/v1/commerce/orders/:orderId/reconcile','CommerceIntegrationsController',c=>commerceReconciliation.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('GET','/api/v1/commerce/reconciliation-jobs/:jobId','CommerceIntegrationsController',c=>commerceReconciliation.get(c.actor,c.params.jobId))
  .add('GET','/api/v1/commerce/payment-disputes','CommerceDisputesController',c => commercePaymentDisputes.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/payment-disputes/:disputeId','CommerceDisputesController',c => commercePaymentDisputes.get(c.actor,c.params.disputeId))
  .add('POST','/api/v1/commerce/stores','CommerceStoresController',c => commerceStores.create(c.actor,c.body),201)
  .add('GET','/api/v1/commerce/stores','CommerceStoresController',c => commerceStores.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/stores/:storeId','CommerceStoresController',c => commerceStores.get(c.actor,c.params.storeId))
  .add('PATCH','/api/v1/commerce/stores/:storeId','CommerceStoresController',c => commerceStores.update(c.actor,c.params.storeId,c.body))
  .add('POST','/api/v1/commerce/stores/:storeId/activate','CommerceStoresController',c => commerceStores.activate(c.actor,c.params.storeId,c.body))
  .add('POST','/api/v1/commerce/storefronts/:storefrontId/publish','CommerceStorefrontsController',c => commerceStores.publishStorefront(c.actor,c.params.storefrontId,c.body))
  .add('POST','/api/v1/commerce/stores/:storeId/suspend','CommerceStoresController',c => commerceStores.update(c.actor,c.params.storeId,c.body,true))
  .add('GET','/api/v1/commerce/stores/:storeId/storefronts','CommerceStorefrontsController',c => commerceStores.storefronts(c.actor,c.params.storeId))
  .add('POST','/api/v1/commerce/stores/:storeId/storefronts','CommerceStorefrontsController',c => commerceStores.storefronts(c.actor,c.params.storeId,c.body),201)
  .add('GET','/api/v1/commerce/stores/:storeId/publications','CommerceStoresController',c => commercePublications.list(c.actor,c.params.storeId,c.query))
  .add('PUT','/api/v1/commerce/stores/:storeId/publications/:productId','CommerceStoresController',c => commercePublications.upsert(c.actor,c.params.storeId,c.params.productId,c.body))
  .addPublic('GET','/api/v1/storefront/:storeSlug/products','CommerceStorefrontsController',c => commercePublications.products(c.params.storeSlug,c.query))
  .addPublic('GET','/api/v1/storefront/:storeSlug/products/:productSlug','CommerceStorefrontsController',c => commercePublications.products(c.params.storeSlug,c.query,c.params.productSlug))
  .add('GET','/api/v1/commerce/stores/:storeId/automation-settings','CommerceIntegrationsController',c => commerceStores.automation(c.actor,c.params.storeId))
  .add('PATCH','/api/v1/commerce/stores/:storeId/automation-settings','CommerceIntegrationsController',c => commerceStores.automation(c.actor,c.params.storeId,c.body))
  .add('GET','/api/v1/commerce/stores/:storeId/promotions','CommercePromotionsController',c => commercePricingPolicies.list(c.actor,c.params.storeId,c.query))
  .add('POST','/api/v1/commerce/stores/:storeId/promotions','CommercePromotionsController',c => commercePricingPolicies.create(c.actor,c.params.storeId,c.body),201)
  .add('PATCH','/api/v1/commerce/promotions/:promotionId','CommercePromotionsController',c => commercePricingPolicies.update(c.actor,c.params.promotionId,c.body))
  .add('POST','/api/v1/commerce/promotions/:promotionId/coupons','CommercePromotionsController',c => commercePricingPolicies.coupon(c.actor,c.params.promotionId,c.body),201)
  .add('GET','/api/v1/commerce/stores/:storeId/tax-rules','CommerceTaxRulesController',c => commercePricingPolicies.list(c.actor,c.params.storeId,c.query,true))
  .add('POST','/api/v1/commerce/stores/:storeId/tax-rules','CommerceTaxRulesController',c => commercePricingPolicies.tax(c.actor,c.body,c.params.storeId),201)
  .add('PATCH','/api/v1/commerce/tax-rules/:taxRuleId','CommerceTaxRulesController',c => commercePricingPolicies.tax(c.actor,c.body,undefined,c.params.taxRuleId))
  .addPublic('POST','/api/v1/storefront/:storeSlug/carts','CommerceCartsController',c => commerceCarts.create(c.params.storeSlug,c.body,c.request.headers.get('x-real-ip') ?? 'public'),201)
  .addPublic('GET','/api/v1/storefront/:storeSlug/carts/:cartToken','CommerceCartsController',c => commerceCarts.get(c.params.storeSlug,c.params.cartToken))
  .addPublic('POST','/api/v1/storefront/:storeSlug/carts/:cartToken/items','CommerceCartsController',c => commerceCarts.mutate(c.params.storeSlug,c.params.cartToken,c.body,'ADD'),201)
  .addPublic('PATCH','/api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId','CommerceCartsController',c => commerceCarts.mutate(c.params.storeSlug,c.params.cartToken,c.body,'UPDATE',c.params.itemId))
  .addPublic('DELETE','/api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId','CommerceCartsController',c => commerceCarts.mutate(c.params.storeSlug,c.params.cartToken,c.body,'DELETE',c.params.itemId))
  .addPublic('POST','/api/v1/storefront/:storeSlug/checkout-sessions','CommerceCheckoutController',c => commerceCheckout.create(c.params.storeSlug,c.body,c.request.headers.get('authorization')),201)
  .addPublic('POST','/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/quote','CommerceCheckoutController',c => commerceCheckout.quote(c.params.storeSlug,c.params.sessionId,checkoutToken(c.request.headers),c.body))
  .addPublic('POST','/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/place-order','CommerceCheckoutController',c => commerceCheckout.place(c.params.storeSlug,c.params.sessionId,checkoutToken(c.request.headers),c.body,c.request.headers.get('idempotency-key')),201)
  .addPublic('GET','/api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/status','CommerceCheckoutController',c => commerceCheckout.status(c.params.storeSlug,c.params.sessionId,checkoutToken(c.request.headers)))
  .addPublic('POST','/api/v1/storefront/:storeSlug/coupons/validate','CommercePromotionsController',c => commerceCheckout.validateCoupon(c.params.storeSlug,c.body))
  .add('GET','/api/v1/commerce/orders','CommerceOrdersController',c => commerceOrders.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/orders/:orderId','CommerceOrdersController',c => commerceOrders.get(c.actor,c.params.orderId))
  .add('GET','/api/v1/commerce/orders/:orderId/history','CommerceOrdersController',c => commerceOrders.get(c.actor,c.params.orderId,true))
  .add('PATCH','/api/v1/commerce/orders/:orderId','CommerceOrdersController',c => commerceOrders.update(c.actor,c.params.orderId,c.body,'UPDATE'))
  .add('POST','/api/v1/commerce/orders/:orderId/cancel','CommerceOrdersController',c => commerceOrders.update(c.actor,c.params.orderId,c.body,'CANCEL'))
  .add('POST','/api/v1/commerce/orders/:orderId/archive','CommerceOrdersController',c => commerceOrders.update(c.actor,c.params.orderId,c.body,'ARCHIVE'))
  .add('GET','/api/v1/commerce/stores/:storeId/delivery-services','CommerceDeliveryController',c => commerceShipments.deliveryServices(c.actor,c.params.storeId))
  .add('POST','/api/v1/commerce/stores/:storeId/delivery-services','CommerceDeliveryController',c => commerceShipments.deliveryServices(c.actor,c.params.storeId,c.body),201)
  .add('GET','/api/v1/commerce/orders/:orderId/shipments','CommerceShipmentsController',c => commerceShipments.list(c.actor,c.params.orderId))
  .add('POST','/api/v1/commerce/orders/:orderId/shipments','CommerceShipmentsController',c => commerceShipments.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),201)
  .add('GET','/api/v1/commerce/shipments/:shipmentId','CommerceShipmentsController',c => commerceShipments.get(c.actor,c.params.shipmentId))
  .add('PATCH','/api/v1/commerce/shipments/:shipmentId','CommerceShipmentsController',c => commerceShipments.update(c.actor,c.params.shipmentId,c.body))
  .add('POST','/api/v1/commerce/shipments/:shipmentId/ship','CommerceShipmentsController',c => commerceShipments.transition(c.actor,c.params.shipmentId,c.body,c.request.headers.get('idempotency-key'),'SHIP'))
  .add('POST','/api/v1/commerce/shipments/:shipmentId/deliver','CommerceShipmentsController',c => commerceShipments.transition(c.actor,c.params.shipmentId,c.body,c.request.headers.get('idempotency-key'),'DELIVER'))
  .add('POST','/api/v1/commerce/shipments/:shipmentId/cancel','CommerceShipmentsController',c => commerceShipments.transition(c.actor,c.params.shipmentId,c.body,c.request.headers.get('idempotency-key'),'CANCEL'))
  .addSignedPublic('/api/v1/commerce/delivery-providers/:providerCode/webhook','CommerceDeliveryController',c => commerceDeliveryCallbacks.receive(c.params.providerCode,c.request.headers,c.rawBody!))
  .add('GET','/api/v1/commerce/orders/:orderId/payments','CommercePaymentsController',c => commercePayments.list(c.actor,c.params.orderId))
  .add('GET','/api/v1/commerce/payments/:paymentId','CommercePaymentsController',c => commercePayments.get(c.actor,c.params.paymentId))
  .add('POST','/api/v1/commerce/orders/:orderId/payments','CommercePaymentsController',c => commercePaymentCommands.create(c.actor,c.params.orderId,c.body,c.request.headers.get('idempotency-key')),202)
  .add('POST','/api/v1/commerce/payments/:paymentId/capture','CommercePaymentsController',c => commercePaymentCommands.change(c.actor,c.params.paymentId,'CAPTURE',c.body,c.request.headers.get('idempotency-key')),202)
  .add('POST','/api/v1/commerce/payments/:paymentId/void','CommercePaymentsController',c => commercePaymentCommands.change(c.actor,c.params.paymentId,'VOID',c.body,c.request.headers.get('idempotency-key')),202)
  .addSignedPublic('/api/v1/commerce/payment-providers/:providerCode/webhook','CommercePaymentsController',c=>commercePaymentCallbacks.receive(c.params.providerCode,c.request.headers,c.rawBody!));

function checkoutToken(headers: Headers) { return headers.get('x-checkout-token') ?? ''; }
