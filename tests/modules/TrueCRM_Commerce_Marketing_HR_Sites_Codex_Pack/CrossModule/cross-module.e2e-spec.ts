import { repositoryHarness } from '../_harness/adapter';
const h=repositoryHarness();
describe('Four-module integration boundaries',()=>{
  it('a Store Order never becomes the CRM Deal identity and integration failure preserves the Order',async()=>{
    const f=await h.seed('commerce_checkout');const orders=await h.observe(f,'orders',{id:f.ids.orderWithCrmOutageId});expect(orders).toHaveLength(1);
    expect(orders[0].id).not.toBe(orders[0].dealId);const audits=await h.observe(f,'audit_events',{resourceId:f.ids.orderWithCrmOutageId});expect(audits.length).toBeGreaterThan(0);
  });
  it('marketing guest cart events do not become legal consent records',async()=>{
    const f=await h.seed('marketing_campaign');const recs=await h.observe(f,'suppression_entries',{destinationHash:f.ids.optedOutDestinationHash});expect(recs.length).toBeGreaterThan(0);
    const sends=await h.observe(f,'provider_calls',{recipientKey:f.ids.recipientKey});expect(sends).toHaveLength(0);
  });
  it('employee termination must preserve prior attendance evidence while revoking workspace access',async()=>{
    const f=await h.seed('hr_attendance');const events=await h.observe(f,'hr_work_events',{employeeId:f.ids.terminatedEmployeeId});expect(events.length).toBeGreaterThan(0);
    const access=await h.request(f,{actor:'employee',method:'GET',path:`/api/v1/hr/employees/${f.ids.terminatedEmployeeId}`});expect([401,403,404]).toContain(access.status);
  });
  it('Site Commerce block never claims checkout success when Commerce service unavailable',async()=>{
    const f=await h.seed('sites_publication');const r=await h.request(f,{actor:'guest',method:'POST',path:`/api/v1/public/checkout-sessions/${f.ids.unavailableCheckoutSessionId}/confirm`,headers:{'Idempotency-Key':'commerce-down'},body:{acceptedQuoteVersion:1}});
    expect([409,503]).toContain(r.status);expect(r.body.success).toBe(false);
  });
});
