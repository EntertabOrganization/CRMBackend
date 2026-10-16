import { prisma } from '../../prisma-client';
import { PackRouter } from '../../process-platform/http';
import { CommerceStoreAdminService } from './store-admin-service';
import { CommerceListingService } from './listing-service';
import { CommerceCustomerPortalService } from './customer-portal-service';
import { CommerceOrderLifecycleService } from './order-lifecycle-service';
import { CommercePaymentLinkService } from './payment-link-service';
import { CommerceOperationsService } from './operations-service';
import { CommercePublicCheckoutService } from './public-checkout-service';
import { CommercePublicationService } from '../publication-service';
import { CommerceCartService } from '../cart-service';
import { CommercePricingPolicyService } from '../pricing-policy-service';
import { CommerceStoreService } from '../store-service';
import { CommercePaymentCallbackService } from '../payment-callback-service';
import { CommerceDeliveryCallbackService } from '../delivery-callback-service';

const stores = new CommerceStoreService(prisma);
export const commerceStoreAdmin = new CommerceStoreAdminService(prisma, stores);
export const commerceListings = new CommerceListingService(prisma, stores);
export const commercePortal = new CommerceCustomerPortalService(prisma);
export const commerceLifecycle = new CommerceOrderLifecycleService(prisma);
export const commercePaymentLinks = new CommercePaymentLinkService(prisma);
export const commerceOperations = new CommerceOperationsService(prisma);
export const commercePublicCheckout = new CommercePublicCheckoutService(prisma);
const publications = new CommercePublicationService(prisma, stores);
const carts = new CommerceCartService(prisma, publications);
const pricing = new CommercePricingPolicyService(prisma, stores);
const paymentCallbacks = new CommercePaymentCallbackService(prisma);
const deliveryCallbacks = new CommerceDeliveryCallbackService(prisma);

const idem = (h: Headers) => h.get('idempotency-key');
const ip = (h: Headers) => h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'public';
const auth = (h: Headers) => h.get('authorization');
const checkoutToken = (h: Headers) => h.get('x-checkout-token') ?? '';

/** TrueCRM OnlineStore-Commerce contract additions. Registered before the legacy commerce routes so extended handlers win. */
export function registerCommerceSuiteRoutes(router: PackRouter) {
  return router
    .add('POST', '/api/v1/commerce/stores', 'CommerceStoresController', c => commerceStoreAdmin.create(c.actor, c.body), 201)
    .add('GET', '/api/v1/commerce/stores/:storeId', 'CommerceStoresController', c => commerceStoreAdmin.detail(c.actor, c.params.storeId))
    .add('PATCH', '/api/v1/commerce/stores/:storeId/policy', 'CommerceStoresController', c => commerceStoreAdmin.updatePolicy(c.actor, c.params.storeId, c.body))
    .add('POST', '/api/v1/commerce/stores/:storeId/activate', 'CommerceStoresController', c => commerceStoreAdmin.activate(c.actor, c.params.storeId, c.body))
    .add('POST', '/api/v1/commerce/stores/:storeId/suspend', 'CommerceStoresController', c => commerceStoreAdmin.suspend(c.actor, c.params.storeId, c.body))
    .add('POST', '/api/v1/commerce/stores/:storeId/archive', 'CommerceStoresController', c => commerceStoreAdmin.archive(c.actor, c.params.storeId, c.body))
    .add('GET', '/api/v1/commerce/stores/:storeId/readiness', 'CommerceStoresController', c => commerceStoreAdmin.readiness(c.actor, c.params.storeId))
    .add('POST', '/api/v1/commerce/stores/:storeId/channels', 'CommerceStoresController', c => commerceStoreAdmin.addChannel(c.actor, c.params.storeId, c.body), 201)
    .add('GET', '/api/v1/commerce/stores/:storeId/entitlement-impact', 'CommerceReportsController', c => commerceStoreAdmin.entitlementImpact(c.actor, c.params.storeId))
    .add('PUT', '/api/v1/commerce/stores/:storeId/listings/:productId', 'CommerceStoresController', c => publications.upsert(c.actor, c.params.storeId, c.params.productId, c.body))
    .add('PATCH', '/api/v1/commerce/listings/:listingId', 'CommerceStoresController', c => commerceListings.patch(c.actor, c.params.listingId, c.body))
    .add('GET', '/api/v1/commerce/stores/:storeId/price-preview', 'CommerceStoresController', c => commerceListings.pricePreview(c.actor, c.params.storeId, c.query))
    .add('GET', '/api/v1/commerce/stores/:storeId/categories', 'CommerceStoresController', c => commerceListings.categories(c.actor, c.params.storeId))
    .add('POST', '/api/v1/commerce/stores/:storeId/categories', 'CommerceStoresController', c => commerceListings.categories(c.actor, c.params.storeId, c.body), 201)
    .add('PUT', '/api/v1/commerce/stores/:storeId/tax-rules', 'CommerceTaxRulesController', c => pricing.tax(c.actor, c.body, c.params.storeId), 201)
    .add('GET', '/api/v1/commerce/order-statuses', 'CommerceOrdersController', c => commerceLifecycle.statuses(c.actor, c.query))
    .add('POST', '/api/v1/commerce/order-statuses', 'CommerceOrdersController', c => commerceLifecycle.createStatus(c.actor, c.body), 201)
    .add('POST', '/api/v1/commerce/orders/:orderId/transition', 'CommerceOrdersController', c => commerceLifecycle.transition(c.actor, c.params.orderId, c.body, idem(c.request.headers)))
    .add('POST', '/api/v1/commerce/orders/:orderId/amend', 'CommerceOrdersController', c => commerceLifecycle.amend(c.actor, c.params.orderId, c.body, idem(c.request.headers)))
    .add('GET', '/api/v1/commerce/orders/:orderId/availability', 'CommerceOrdersController', c => commerceLifecycle.availability(c.actor, c.params.orderId))
    .add('POST', '/api/v1/commerce/orders/:orderId/reservations/refresh', 'CommerceOrdersController', c => commerceLifecycle.refreshReservations(c.actor, c.params.orderId, idem(c.request.headers)))
    .add('POST', '/api/v1/commerce/orders/:orderId/backorder-action', 'CommerceOrdersController', c => commerceLifecycle.backorderAction(c.actor, c.params.orderId, c.body))
    .add('POST', '/api/v1/commerce/orders/:orderId/payment-intents', 'CommercePaymentsController', c => commercePaymentLinks.createIntent(c.actor, c.params.orderId, c.body, idem(c.request.headers)), 201)
    .add('POST', '/api/v1/commerce/orders/:orderId/payment-links', 'CommercePaymentsController', c => commercePaymentLinks.issueLink(c.actor, c.params.orderId, c.body), 201)
    .add('POST', '/api/v1/commerce/payment-links/:linkId/revoke', 'CommercePaymentsController', c => commercePaymentLinks.revokeLink(c.actor, c.params.linkId))
    .add('POST', '/api/v1/commerce/conversations/:conversationId/payment-links', 'CommerceIntegrationsController', c => commercePaymentLinks.issueLink(c.actor, String((c.body as { orderId?: string }).orderId ?? ''), { ...(c.body as object), orderId: undefined }, c.params.conversationId), 201)
    .add('POST', '/api/v1/commerce/orders/:orderId/fulfillments', 'CommerceShipmentsController', c => commerceOperations.createFulfillment(c.actor, c.params.orderId, c.body, idem(c.request.headers)), 201)
    .add('PATCH', '/api/v1/commerce/fulfillments/:fulfillmentId', 'CommerceShipmentsController', c => commerceOperations.updateFulfillment(c.actor, c.params.fulfillmentId, c.body))
    .add('POST', '/api/v1/commerce/shipments/:shipmentId/dispatch', 'CommerceShipmentsController', c => commerceOperations.dispatch(c.actor, c.params.shipmentId, c.body, idem(c.request.headers)))
    .add('POST', '/api/v1/commerce/shipments/:shipmentId/tracking', 'CommerceShipmentsController', c => commerceOperations.tracking(c.actor, c.params.shipmentId, c.body))
    .add('POST', '/api/v1/commerce/returns/:returnId/refund', 'CommerceReturnsController', c => commerceOperations.refundReturn(c.actor, c.params.returnId, c.body, idem(c.request.headers)), 201)
    .add('GET', '/api/v1/commerce/returns/:returnId/history', 'CommerceReturnsController', c => commerceOperations.returnHistory(c.actor, c.params.returnId))
    .add('POST', '/api/v1/commerce/sync/retry/:syncId', 'CommerceIntegrationsController', c => commerceOperations.retrySync(c.actor, c.params.syncId))
    .add('GET', '/api/v1/commerce/sync/failures', 'CommerceIntegrationsController', c => commerceOperations.syncFailures(c.actor))
    .add('GET', '/api/v1/commerce/reports/orders', 'CommerceReportsController', c => commerceOperations.report(c.actor, 'orders', c.query))
    .add('GET', '/api/v1/commerce/reports/revenue', 'CommerceReportsController', c => commerceOperations.report(c.actor, 'revenue', c.query))
    .add('GET', '/api/v1/commerce/reports/abandoned-carts', 'CommerceReportsController', c => commerceOperations.report(c.actor, 'abandoned-carts', c.query))
    .add('GET', '/api/v1/commerce/reports/fulfillment', 'CommerceReportsController', c => commerceOperations.report(c.actor, 'fulfillment', c.query))
    .add('POST', '/api/v1/commerce/orders/:orderId/digital-fulfillment', 'CommerceDigitalController', c => commerceOperations.digitalFulfillment(c.actor, c.params.orderId, c.body), 201)
    .add('POST', '/api/v1/commerce/orders/:orderId/digital-revoke', 'CommerceDigitalController', c => commerceOperations.revokeDigitalForOrder(c.actor, c.params.orderId, c.body))
    .add('POST', '/api/v1/commerce/services/:orderLineId/complete', 'CommerceDigitalController', c => commerceOperations.completeService(c.actor, c.params.orderLineId, c.body))
    .add('POST', '/api/v1/commerce/orders/:orderId/guest-access-links', 'CommerceCustomersController', c => commercePortal.adminIssueGuestLink(c.actor, c.params.orderId), 201)
    .add('POST', '/api/v1/commerce/customer-identities/:identityId/status', 'CommerceCustomersController', c => commercePortal.setIdentityStatus(c.actor, c.params.identityId, c.body))
    .add('GET', '/api/v1/crm/contacts/:contactId/commerce/orders', 'CommerceCrmController', c => commerceOperations.contactOrders(c.actor, c.params.contactId));
}

/** Public storefront/customer/provider endpoints (no employee session). */
export const commercePublicRouter = new PackRouter()
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/carts', 'CommercePublicController', c => carts.create(c.params.storeSlug, c.body, ip(c.request.headers)), 201)
  .addPublic('GET', '/api/v1/public/stores/:storeSlug/products', 'CommercePublicController', c => publications.products(c.params.storeSlug, c.query))
  .addPublic('GET', '/api/v1/public/stores/:storeSlug/products/:productSlug', 'CommercePublicController', c => publications.products(c.params.storeSlug, c.query, c.params.productSlug))
  .addPublic('GET', '/api/v1/public/stores/:storeSlug/payment-return', 'CommercePublicController', c => commercePaymentLinks.paymentReturn(c.params.storeSlug, c.query))
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/customers/register', 'CommercePortalController', c => commercePortal.register(c.params.storeSlug, c.body, ip(c.request.headers)), 202)
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/customers/verify', 'CommercePortalController', c => commercePortal.verify(c.params.storeSlug, c.body))
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/customers/login', 'CommercePortalController', c => commercePortal.login(c.params.storeSlug, c.body, ip(c.request.headers)))
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/customers/recover', 'CommercePortalController', c => commercePortal.recover(c.params.storeSlug, c.body, ip(c.request.headers)), 202)
  .addPublic('POST', '/api/v1/public/stores/:storeSlug/customers/reset-password', 'CommercePortalController', c => commercePortal.resetPassword(c.params.storeSlug, c.body))
  .addPublic('POST', '/api/v1/public/carts/:cartToken/items', 'CommercePublicController', c => commercePublicCheckout.cartItems(c.params.cartToken, c.body, 'ADD'), 201)
  .addPublic('PATCH', '/api/v1/public/carts/:cartToken/items/:lineId', 'CommercePublicController', c => commercePublicCheckout.cartItems(c.params.cartToken, c.body, 'UPDATE', c.params.lineId))
  .addPublic('DELETE', '/api/v1/public/carts/:cartToken/items/:lineId', 'CommercePublicController', c => commercePublicCheckout.cartItems(c.params.cartToken, c.body, 'DELETE', c.params.lineId))
  .addPublic('POST', '/api/v1/public/carts/:cartToken/checkout-sessions', 'CommercePublicController', c => commercePublicCheckout.openSession(c.params.cartToken, c.body, auth(c.request.headers)), 201)
  .addPublic('POST', '/api/v1/public/carts/:cartToken/coupons', 'CommercePublicController', c => commercePublicCheckout.coupon(c.params.cartToken, c.body))
  .addPublic('POST', '/api/v1/public/carts/:cartToken/delivery-quote', 'CommercePublicController', c => commerceOperations.deliveryQuote(c.params.cartToken, c.body, ip(c.request.headers)))
  .addPublic('POST', '/api/v1/public/checkout-sessions/:sessionId/quote', 'CommercePublicController', c => commercePublicCheckout.quote(c.params.sessionId, checkoutToken(c.request.headers), c.body))
  .addPublic('POST', '/api/v1/public/checkout-sessions/:sessionId/confirm', 'CommercePublicController', c => commercePublicCheckout.confirm(c.params.sessionId, checkoutToken(c.request.headers), c.body, idem(c.request.headers)), 201)
  .addPublic('POST', '/api/v1/public/order-access/exchange', 'CommercePortalController', c => commercePortal.exchange(c.body, ip(c.request.headers)))
  .addPublic('GET', '/api/v1/public/payment-links/:token', 'CommercePublicController', c => commercePaymentLinks.resolveLink(c.params.token, ip(c.request.headers)))
  .addPublic('POST', '/api/v1/public/digital-deliveries/:deliveryId/token', 'CommercePortalController', c => commerceOperations.digitalToken(auth(c.request.headers), c.params.deliveryId), 201)
  .addPublic('GET', '/api/v1/public/digital-deliveries/:deliveryId/download', 'CommercePortalController', c => commerceOperations.download(c.params.deliveryId, c.query.token ?? ''))
  .addPublic('GET', '/api/v1/customer/orders', 'CommercePortalController', c => commercePortal.orders(auth(c.request.headers), c.query))
  .addPublic('GET', '/api/v1/customer/orders/:orderId', 'CommercePortalController', c => commercePortal.order(auth(c.request.headers), c.params.orderId))
  .addPublic('GET', '/api/v1/customer/orders/:orderId/tracking', 'CommercePortalController', c => commercePortal.tracking(auth(c.request.headers), c.params.orderId))
  .addPublic('GET', '/api/v1/customer/orders/:orderId/digital-items', 'CommercePortalController', c => commerceOperations.customerDigitalItems(auth(c.request.headers), c.params.orderId))
  .addPublic('POST', '/api/v1/customer/orders/:orderId/cancel-request', 'CommercePortalController', c => commercePortal.cancelRequest(auth(c.request.headers), c.params.orderId, c.body), 202)
  .addPublic('POST', '/api/v1/customer/orders/:orderId/returns', 'CommercePortalController', c => commercePortal.returnRequest(auth(c.request.headers), c.params.orderId, c.body), 202)
  .addSignedPublic('/api/v1/integrations/payments/:provider/webhook', 'CommerceProviderController', c => paymentCallbacks.receive(c.params.provider.toLowerCase(), c.request.headers, c.rawBody!))
  .addSignedPublic('/api/v1/integrations/shipping/:provider/webhook', 'CommerceProviderController', c => deliveryCallbacks.receive(c.params.provider, c.request.headers, c.rawBody!));
