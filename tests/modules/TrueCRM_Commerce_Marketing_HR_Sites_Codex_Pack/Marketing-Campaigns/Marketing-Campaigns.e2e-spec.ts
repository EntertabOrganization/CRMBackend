import { repositoryHarness } from '../_harness/adapter';
const h=repositoryHarness();
describe('Marketing HTTP + delivery ledger E2E contract',()=>{
  it('suppresses recipient who unsubscribes after campaign audience freeze',async()=>{
    const f=await h.seed('marketing_campaign');
    const opt=await h.request(f,{actor:'customer',method:'POST',path:'/api/v1/public/marketing/unsubscribe',body:{token:f.ids.optoutToken}});expect([200,204]).toContain(opt.status);
    const start=await h.request(f,{actor:'marketer',method:'POST',path:`/api/v1/marketing/campaigns/${f.ids.campaignId}/launch`,headers:{'Idempotency-Key':'launch-suppress-1'},body:{expectedVersion:Number(f.metadata?.campaignVersion??1),approvedRevision:Number(f.metadata?.approvedRevision??1)}});
    expect([200,202]).toContain(start.status);
    const delivers=await h.observe(f,'marketing_deliveries',{campaignId:f.ids.campaignId,recipientKey:f.ids.recipientKey});
    expect(delivers.every((x:any)=>!['ACCEPTED','DELIVERED'].includes(x.state))).toBe(true);
    const calls=await h.observe(f,'provider_calls',{campaignId:f.ids.campaignId,recipientKey:f.ids.recipientKey});expect(calls).toHaveLength(0);
  });
  it('does not leak imported recipients through segment read without export rights',async()=>{
    const f=await h.seed('marketing_campaign');const r=await h.request(f,{actor:'employee',method:'GET',path:`/api/v1/marketing/segments/${f.ids.segmentId}/export`});
    expect([403,404]).toContain(r.status);
  });
  it('never creates duplicate deliveries for repeated launch',async()=>{
    const f=await h.seed('marketing_campaign');const body={expectedVersion:Number(f.metadata?.campaignVersion??1),approvedRevision:Number(f.metadata?.approvedRevision??1)};
    const path=`/api/v1/marketing/campaigns/${f.ids.campaignId}/launch`;
    const [a,b]=await Promise.all([h.request(f,{actor:'marketer',method:'POST',path,body,headers:{'Idempotency-Key':'launch-once'}}),h.request(f,{actor:'marketer',method:'POST',path,body,headers:{'Idempotency-Key':'launch-once'}})]);
    expect([200,202,409]).toContain(a.status);expect([200,202,409]).toContain(b.status);
    const deliver=await h.observe(f,'marketing_deliveries',{campaignId:f.ids.campaignId});
    const keys=deliver.map((x:any)=>x.idempotencyKey);expect(new Set(keys).size).toBe(keys.length);
  });
  it('does not let foreign workspace marketer read segment',async()=>{
    const f=await h.seed('marketing_campaign');const r=await h.request(f,{actor:'marketer',method:'GET',path:`/api/v1/marketing/segments/${f.ids.foreignSegmentId}`});
    expect([403,404]).toContain(r.status);
  });
  it('material content edits invalidate old approval',async()=>{
    const f=await h.seed('marketing_campaign');const r=await h.request(f,{actor:'marketer',method:'PATCH',path:`/api/v1/marketing/campaigns/${f.ids.approvedCampaignId}`,body:{name:'Revised substantial campaign',templateVersionId:f.ids.newTemplateVersionId}});
    expect([200,409]).toContain(r.status);const events=await h.observe(f,'audit_events',{resourceId:f.ids.approvedCampaignId});expect(events.length).toBeGreaterThan(0);
    if(r.status===200) expect(r.body.data?.status).not.toBe('APPROVED');
  });
});
