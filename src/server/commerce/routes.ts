import { prisma } from '../prisma-client';
import { PackRouter } from '../process-platform/http';
import { CommerceStoreService } from './store-service';
import { CommercePublicationService } from './publication-service';
import { CommercePricingPolicyService } from './pricing-policy-service';
export const commerceStores = new CommerceStoreService(prisma);
export const commercePublications = new CommercePublicationService(prisma,commerceStores);
export const commercePricingPolicies = new CommercePricingPolicyService(prisma,commerceStores);
export const commerceRouter = new PackRouter()
  .add('POST','/api/v1/commerce/stores','CommerceStoresController',c => commerceStores.create(c.actor,c.body),201)
  .add('GET','/api/v1/commerce/stores','CommerceStoresController',c => commerceStores.list(c.actor,c.query))
  .add('GET','/api/v1/commerce/stores/:storeId','CommerceStoresController',c => commerceStores.get(c.actor,c.params.storeId))
  .add('PATCH','/api/v1/commerce/stores/:storeId','CommerceStoresController',c => commerceStores.update(c.actor,c.params.storeId,c.body))
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
  .add('PATCH','/api/v1/commerce/tax-rules/:taxRuleId','CommerceTaxRulesController',c => commercePricingPolicies.tax(c.actor,c.body,undefined,c.params.taxRuleId));
