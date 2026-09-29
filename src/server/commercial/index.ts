import type { AccessService } from '../access-service';
import type { CrmCoreService } from '../crm-core-service';
import type { CrmPipelineService } from '../crm-pipeline-service';
import type { InMemoryStore } from '../store';
import { ChannelConnectorRegistry, DeterministicChannelConnector, UnconfiguredChannelConnector } from './channel-connectors';
import { CommerceService } from './commerce-service';
import { ContactCenterService } from './contact-center-service';
import { FormService } from './form-service';
import { DeterministicPaymentAdapter, PaymentProviderRegistry, StripePaymentAdapter, UnconfiguredPaymentAdapter, XPayPaymentAdapter } from './payment-providers';
import { RequisiteService } from './requisite-service';
import { CommercialBackgroundJobService } from './background-job-service';
import { FormProtectionRegistry, HmacFormProtectionAdapter } from './form-protection';
import { DeterministicFormFileAdapter, UnconfiguredFormFileAdapter } from './form-files';

export class CommercialCaptureContactCenterModule {
  readonly requisites:RequisiteService;
  readonly paymentProviders:PaymentProviderRegistry;
  readonly commerce:CommerceService;
  readonly forms:FormService;
  readonly formProtection:FormProtectionRegistry;
  readonly channelConnectors:ChannelConnectorRegistry;
  readonly contactCenter:ContactCenterService;
  readonly jobs:CommercialBackgroundJobService;
  constructor(deps:{store:InMemoryStore;access:AccessService;crmCore:CrmCoreService;crm:CrmPipelineService}){
    this.requisites=new RequisiteService(deps.store,deps.access);
    const testProviders=process.env.NODE_ENV==='test';
    const stripeConfigured=process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.STRIPE_ACCOUNT_ID;
    const xpayConfigured=process.env.XPAY_SECRET_KEY&&process.env.XPAY_WEBHOOK_SECRET&&process.env.XPAY_MERCHANT_ID&&process.env.XPAY_RETURN_URL;
    this.paymentProviders=new PaymentProviderRegistry()
      .register(testProviders?new DeterministicPaymentAdapter('stripe','test-stripe-secret','stripe-test-merchant'):stripeConfigured?new StripePaymentAdapter(process.env.STRIPE_SECRET_KEY!,process.env.STRIPE_WEBHOOK_SECRET!,process.env.STRIPE_ACCOUNT_ID!):new UnconfiguredPaymentAdapter('stripe'))
      .register(testProviders?new DeterministicPaymentAdapter('xpay','test-xpay-secret','xpay-test-community',true):xpayConfigured?new XPayPaymentAdapter(process.env.XPAY_SECRET_KEY!,process.env.XPAY_WEBHOOK_SECRET!,process.env.XPAY_MERCHANT_ID!,process.env.XPAY_RETURN_URL!,process.env.XPAY_API_BASE_URL):new UnconfiguredPaymentAdapter('xpay'));
    if(testProviders)this.paymentProviders.register(new DeterministicPaymentAdapter('fake','test-fake-secret','fake-merchant'));
    this.commerce=new CommerceService(deps.store,deps.access,this.requisites,this.paymentProviders);
    this.formProtection=new FormProtectionRegistry();
    if(testProviders||process.env.FORM_PROTECTION_SECRET)this.formProtection.register(new HmacFormProtectionAdapter(process.env.FORM_PROTECTION_SECRET??'test-form-protection-secret'));
    this.forms=new FormService(deps.store,deps.access,deps.crmCore,deps.crm,this.commerce,this.formProtection,testProviders?new DeterministicFormFileAdapter():new UnconfiguredFormFileAdapter());
    this.channelConnectors=new ChannelConnectorRegistry()
      .register(testProviders?new DeterministicChannelConnector('webchat','test-webchat-secret',['SENT','DELIVERED','READ']):new UnconfiguredChannelConnector('webchat'))
      .register(testProviders?new DeterministicChannelConnector('whatsapp','test-whatsapp-secret',['SENT','DELIVERED','READ']):new UnconfiguredChannelConnector('whatsapp'))
      .register(testProviders?new DeterministicChannelConnector('email','test-email-secret',['SENT','DELIVERED']):new UnconfiguredChannelConnector('email'))
      .register(testProviders?new DeterministicChannelConnector('telegram','test-telegram-secret',['SENT','DELIVERED','READ']):new UnconfiguredChannelConnector('telegram'))
      .register(testProviders?new DeterministicChannelConnector('sms','test-sms-secret',['SENT','DELIVERED']):new UnconfiguredChannelConnector('sms'))
      .register(testProviders?new DeterministicChannelConnector('telephony','test-telephony-secret',['SENT']):new UnconfiguredChannelConnector('telephony'))
      .register(testProviders?new DeterministicChannelConnector('callback','test-callback-secret',['SENT']):new UnconfiguredChannelConnector('callback'));
    this.contactCenter=new ContactCenterService(deps.store,deps.access,this.channelConnectors,deps.crmCore,deps.crm);
    this.jobs=new CommercialBackgroundJobService(deps.store,deps.access,this.commerce,this.forms,this.contactCenter);
  }
}

export * from './types';
export * from './payment-providers';
export * from './channel-connectors';
export * from './form-protection';
export * from './form-files';
