import type { AccessService } from '../access-service';
import type { CrmCoreService } from '../crm-core-service';
import type { InMemoryStore } from '../store';
import { AnalyticsService } from './analytics';
import { DataQualityService } from './data-quality';
import { IntegrationAdapterRegistry, IntegrationService } from './integrations';
import { AdvertisingAdapterRegistry, DeterministicAdvertisingAdapter, SalesIntelligenceService } from './sales-intelligence';
import { EntitlementService, RetentionService, SharedJobService } from './shared';

export class DataIntegrationIntelligenceAnalyticsModule {
  readonly entitlements:EntitlementService;
  readonly jobs:SharedJobService;
  readonly retention:RetentionService;
  readonly dataQuality:DataQualityService;
  readonly integrationAdapters:IntegrationAdapterRegistry;
  readonly integrations:IntegrationService;
  readonly advertisingAdapters:AdvertisingAdapterRegistry;
  readonly salesIntelligence:SalesIntelligenceService;
  readonly analytics:AnalyticsService;
  constructor(deps:{store:InMemoryStore;access:AccessService;crmCore:CrmCoreService}){
    this.entitlements=new EntitlementService(deps.store);
    this.jobs=new SharedJobService(deps.store);
    this.retention=new RetentionService(deps.store);
    this.dataQuality=new DataQualityService(deps.store,deps.access,this.jobs);
    this.integrationAdapters=new IntegrationAdapterRegistry();
    this.integrations=new IntegrationService(deps.store,deps.access,deps.crmCore,this.integrationAdapters,this.jobs,this.entitlements,this.retention);
    this.advertisingAdapters=new AdvertisingAdapterRegistry();
    if(process.env.NODE_ENV==='test')this.advertisingAdapters.register(new DeterministicAdvertisingAdapter('google_ads')).register(new DeterministicAdvertisingAdapter('meta_ads'));
    this.salesIntelligence=new SalesIntelligenceService(deps.store,deps.access,this.jobs,this.advertisingAdapters);
    this.analytics=new AnalyticsService(deps.store,deps.access,this.jobs,this.entitlements,this.retention);
  }
}

export * from './types';
export * from './shared';
export * from './data-quality';
export * from './integrations';
export * from './sales-intelligence';
export * from './analytics';
