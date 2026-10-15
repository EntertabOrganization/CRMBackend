import { repositoryHarness } from '../_harness/adapter';
const h=repositoryHarness();
describe('Commerce HTTP + PostgreSQL E2E contract',()=>{
  it('confirms exactly one order for repeated checkout idempotency key',async()=>{
    const f=await h.seed('commerce_checkout'); const req={actor:'guest' as const,method:'POST' as const,path:`/api/v1/public/checkout-sessions/${f.ids.checkoutSessionId}/confirm`,headers:{'Idempotency-Key':'same-checkout-001'},body:{buyer:{type:'INDIVIDUAL',name:'Fixture Buyer',email:'buyer@example.test'},paymentMethodId:f.ids.paymentMethodId,deliveryMethodId:f.ids.deliveryMethodId,acceptedQuoteVersion:1}};
    const a=await h.request(f,req),b=await h.request(f,req);
    expect([200,201,202]).toContain(a.status); expect(b.body.data?.id).toBe(a.body.data?.id);
    const orders=await h.observe(f,'orders',{id:a.body.data.id});expect(orders).toHaveLength(1);
    const audit=await h.observe(f,'audit_events',{resourceId:a.body.data.id});expect(audit.length).toBeGreaterThan(0);
    const outbox=await h.observe(f,'outbox_events',{resourceId:a.body.data.id,eventType:'ORDER_CREATED'});expect(outbox).toHaveLength(1);
  });
  it('rejects a known Order ID from another workspace without leaking data',async()=>{
    const f=await h.seed('commerce_checkout');const r=await h.request(f,{actor:'owner',method:'GET',path:`/api/v1/commerce/orders/${f.ids.foreignOrderId}`});
    expect([403,404]).toContain(r.status);expect(r.body.success).toBe(false);
  });
  it('cannot create paid state from customer redirect without verified callback',async()=>{
    const f=await h.seed('commerce_checkout');const r=await h.request(f,{actor:'guest',method:'GET',path:`/api/v1/public/stores/${f.ids.storeSlug}/payment-return?orderId=${f.ids.pendingOrderId}&success=true`});
    expect([200,302,303,404]).toContain(r.status);
    const orders=await h.observe(f,'orders',{id:f.ids.pendingOrderId}); expect(orders).toHaveLength(1); expect(orders[0].paymentStatus).not.toBe('PAID');
  });
  it('rejects unsigned/spoofed payment provider events',async()=>{
    const f=await h.seed('commerce_checkout');const before=await h.observe(f,'payment_allocations',{orderId:f.ids.pendingOrderId});
    const r=await h.request(f,{actor:'guest',method:'POST',path:'/api/v1/integrations/payments/stripe/webhook',headers:{'X-Test-Signature':'invalid'},body:{id:'spoofed',type:'payment_intent.succeeded'}});
    expect([400,401,403]).toContain(r.status);const after=await h.observe(f,'payment_allocations',{orderId:f.ids.pendingOrderId});expect(after).toHaveLength(before.length);
  });
  it('prevents overselling under concurrent checkouts',async()=>{
    const f=await h.seed('commerce_checkout');
    const act=(sid:string,key:string)=>h.request(f,{actor:'guest',method:'POST',path:`/api/v1/public/checkout-sessions/${sid}/confirm`,headers:{'Idempotency-Key':key},body:{buyer:{type:'INDIVIDUAL',name:'Test',email:'test@example.test'},paymentMethodId:f.ids.paymentMethodId,deliveryMethodId:f.ids.deliveryMethodId,acceptedQuoteVersion:1}});
    await Promise.all([act(f.ids.stockRaceSessionA,'race-a'),act(f.ids.stockRaceSessionB,'race-b')]);
    const reserved=await h.observe(f,'inventory_reservations',{variantId:f.ids.raceVariantId,status:'ACTIVE'});
    const sum=reserved.reduce((v:number,row:any)=>v+Number(row.quantity),0);expect(sum).toBeLessThanOrEqual(1);
  });
  it('keeps original captured payment and records exception when stock expires',async()=>{
    const f=await h.seed('commerce_checkout');const rows=await h.observe(f,'orders',{id:f.ids.latePaidOrderId});expect(rows).toHaveLength(1);
    expect(rows[0].paymentStatus).toBe('PAID');expect(rows[0].fulfillmentStatus).toBe('EXCEPTION');
    const allocated=await h.observe(f,'payment_allocations',{orderId:f.ids.latePaidOrderId});expect(allocated.length).toBeGreaterThan(0);
  });
});
