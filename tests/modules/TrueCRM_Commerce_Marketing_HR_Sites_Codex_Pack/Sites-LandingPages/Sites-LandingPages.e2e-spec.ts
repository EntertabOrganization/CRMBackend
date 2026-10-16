import { repositoryHarness } from '../_harness/adapter';
const h=repositoryHarness();
describe('Sites HTTP + release persistence E2E contract',()=>{
  it('draft updates do not replace active public release',async()=>{
    const f=await h.seed('sites_publication');const old=await h.observe(f,'site_releases',{siteId:f.ids.siteId,status:'ACTIVE'});
    expect(old).toHaveLength(1);const edit=await h.request(f,{actor:'publisher',method:'POST',path:`/api/v1/sites/pages/${f.ids.pageId}/revisions`,body:{blockTreeJson:{blocks:[{type:'headline',text:'Draft only'}]}}});
    expect([200,201]).toContain(edit.status);const next=await h.observe(f,'site_releases',{siteId:f.ids.siteId,status:'ACTIVE'});expect(next.map((x:any)=>x.id)).toEqual(old.map((x:any)=>x.id));
  });
  it('editor without publish permission cannot activate a release',async()=>{
    const f=await h.seed('sites_publication');const r=await h.request(f,{actor:'employee',method:'POST',path:`/api/v1/sites/${f.ids.siteId}/releases/publish`,headers:{'Idempotency-Key':'unprivileged-publish'},body:{releaseId:f.ids.draftReleaseId}});
    expect([403,404]).toContain(r.status);const rows=await h.observe(f,'site_releases',{id:f.ids.draftReleaseId});expect(rows.every((x:any)=>x.status!=='ACTIVE')).toBe(true);
  });
  it('foreign workspace Site ID is not accessible',async()=>{
    const f=await h.seed('sites_publication');const r=await h.request(f,{actor:'publisher',method:'GET',path:`/api/v1/sites/${f.ids.foreignSiteId}`});expect([403,404]).toContain(r.status);
  });
  it('unverified domain cannot be activated for an unrelated Site',async()=>{
    const f=await h.seed('sites_publication');const r=await h.request(f,{actor:'publisher',method:'POST',path:`/api/v1/sites/${f.ids.siteId}/domains`,body:{hostname:f.ids.foreignDomain}});expect([400,403,409]).toContain(r.status);
  });
  it('expired/revoked preview token is not publicly accessible',async()=>{
    const f=await h.seed('sites_publication');const r=await h.request(f,{actor:'guest',method:'GET',path:`/api/v1/sites/${f.ids.siteId}/previews/${f.ids.expiredPreviewToken}`});expect([401,403,404,410]).toContain(r.status);
  });
  it('shared block draft edit does not update already published site release',async()=>{
    const f=await h.seed('sites_publication');const before=await h.observe(f,'site_releases',{siteId:f.ids.siteId,status:'ACTIVE'});
    const r=await h.request(f,{actor:'publisher',method:'POST',path:`/api/v1/sites/shared-blocks/${f.ids.sharedBlockId}/revisions`,body:{propsJson:{text:'Changed in draft'}}});expect([200,201]).toContain(r.status);
    const after=await h.observe(f,'site_releases',{siteId:f.ids.siteId,status:'ACTIVE'});expect(after.map((x:any)=>x.id)).toEqual(before.map((x:any)=>x.id));
  });
});
