# Bitrix REST Reference Notes

Bitrix documentation was used only to reduce unnecessary product-design questions and to validate common CRM/catalog patterns. It is not an implementation compatibility requirement.

## Official references consulted

- General REST API documentation: https://apidocs.bitrix24.com/
- Developing with REST API: https://apidocs.bitrix24.com/developing-with-rest-api.html
- Register Automation Rule: https://apidocs.bitrix24.com/api-reference/bizproc/bizproc-robot/bizproc-robot-add.html
- Add Automation Trigger: https://apidocs.bitrix24.com/api-reference/crm/automation/triggers/crm-automation-trigger-add.html
- Execute Automation Trigger: https://apidocs.bitrix24.com/api-reference/crm/automation/triggers/crm-automation-trigger-execute.html
- Product/Offer APIs: https://apidocs.bitrix24.com/api-reference/catalog/product/index.html
- Product Variation examples: https://apidocs.bitrix24.com/api-reference/catalog/product/offer/catalog-product-offer-add.html
- Catalog price APIs / price types: https://apidocs.bitrix24.com/api-reference/catalog/price/index.html and related Catalog sections
- CRM Product Row API: https://apidocs.bitrix24.com/api-reference/crm/universal/product-rows/crm-item-productrow-add.html

## Behaviors used as reference

- stable codes for registered Automation Triggers/Rules;
- application-scoped Automation extension concept;
- CRM owner/target context for Trigger execution;
- Product vs Product Variation distinction;
- Catalog section/category relationships;
- multiple Product prices through price types;
- unit/measurement concepts and ratios;
- commercial Product Row fields including Product reference/name, price, quantity, discount, tax and measure.

## Behaviors intentionally not copied blindly

- Bitrix internal owner type numeric IDs;
- Bitrix information-block (`iblock`) storage model;
- Bitrix-specific permission names;
- Bitrix-specific webhook/auth URL formats;
- Bitrix-specific UI naming;
- any behavior conflicting with confirmed TrueCRM decisions.

TrueCRM's BRD/PRD/Architecture and `Decision-Register.md` are authoritative.
