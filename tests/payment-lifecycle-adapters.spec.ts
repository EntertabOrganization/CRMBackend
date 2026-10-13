import { DeterministicLifecyclePaymentAdapter,StripePaymentAdapter,XPayPaymentAdapter } from '../src/server/commercial/payment-providers';
const input={amount:'100',currencyCode:'EGP',idempotencyKey:'create-payment-key',mode:'AUTHORIZE' as const};
const sandbox=()=>new DeterministicLifecyclePaymentAdapter('sandbox','test-only-signing-secret','merchant-test');
const intent=(overrides:Record<string,unknown>={})=>({id:'pi_test',currency:'egp',amount:10000,amount_received:0,amount_capturable:10000,status:'requires_capture',...overrides});
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
afterEach(()=>jest.restoreAllMocks());

describe('Changed shared provider lifecycle adapters',()=>{
  it('keeps authorization separate from settled funds and captures only the remaining amount',async()=>{
    const provider=sandbox(),created=await provider.createPaymentAttempt(input);
    expect((await provider.retrieveLifecycle(created.transactionId)).status).toBe('PENDING');
    provider.authorize(created.transactionId);
    expect(await provider.retrieveLifecycle(created.transactionId)).toMatchObject({status:'AUTHORIZED',authorizedAmount:'100',capturedAmount:'0'});
    const first={transactionId:created.transactionId,amount:'20',currencyCode:'EGP',idempotencyKey:'capture-first'};
    const a=await provider.capture(first);expect(a).toMatchObject({status:'PARTIALLY_CAPTURED',capturedAmount:'20'});
    const b=await provider.capture({...first,amount:'80',idempotencyKey:'capture-second'});expect(b).toMatchObject({status:'PAID',capturedAmount:'100'});
    expect(await provider.capture(first)).toEqual(a);
    expect((await provider.retrieveLifecycle(created.transactionId)).capturedAmount).toBe('100');
    await expect(provider.capture({...first,amount:'21'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('deduplicates concurrent captures and rejects concurrent overcapture',async()=>{
    const provider=sandbox(),created=await provider.createPaymentAttempt(input);provider.authorize(created.transactionId);
    const command={transactionId:created.transactionId,amount:'60',currencyCode:'EGP',idempotencyKey:'capture-concurrent'};
    const [a,b]=await Promise.all([provider.capture(command),provider.capture(command)]);expect(a).toEqual(b);
    await expect(provider.capture({...command,idempotencyKey:'another-capture'})).rejects.toMatchObject({code:'PAYMENT_CAPTURE_EXCEEDS_AUTHORIZATION'});
    expect((await provider.retrieveLifecycle(created.transactionId)).capturedAmount).toBe('60');
  });
  it('retains provider identity on create retries and rejects changes or late settlement after void',async()=>{
    const provider=sandbox(),created=await provider.createPaymentAttempt(input);provider.authorize(created.transactionId);
    expect(await provider.createPaymentAttempt(input)).toEqual(created);expect((await provider.retrieveLifecycle(created.transactionId)).status).toBe('AUTHORIZED');
    await expect(provider.createPaymentAttempt({...input,amount:'101'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const command={transactionId:created.transactionId,idempotencyKey:'void-payment-key'};
    expect((await provider.void(command)).status).toBe('VOIDED');expect((await provider.void(command)).status).toBe('VOIDED');
    expect(()=>provider.settle(created.transactionId,'SUCCEEDED')).toThrow(expect.objectContaining({code:'PAYMENT_INVALID_STATE'}));
    await expect(provider.capture({transactionId:created.transactionId,idempotencyKey:'late-capture',amount:'1',currencyCode:'EGP'})).rejects.toMatchObject({code:'PAYMENT_INVALID_STATE'});
  });
  it('refuses voids after partial capture and rejects imprecise capture inputs',async()=>{
    const provider=sandbox(),created=await provider.createPaymentAttempt(input);provider.authorize(created.transactionId);
    await expect(provider.capture({transactionId:created.transactionId,idempotencyKey:'bad-precision',amount:'0.001',currencyCode:'EGP'})).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
    await provider.capture({transactionId:created.transactionId,idempotencyKey:'some-capture',amount:'1',currencyCode:'EGP'});
    await expect(provider.void({transactionId:created.transactionId,idempotencyKey:'bad-void'})).rejects.toMatchObject({code:'PAYMENT_INVALID_STATE'});
  });
  it('sends Stripe manual authorization and idempotent partial capture requests',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(intent({status:'requires_payment_method',amount_capturable:0,client_secret:'test-client-secret'}))).mockResolvedValueOnce(json(intent({amount_received:2000,amount_capturable:8000})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test',true);
    const created=await provider.createPaymentAttempt(input);expect(created.transactionId).toBe('pi_test');
    const createInit=fetchMock.mock.calls[0][1]!;expect((createInit.body as URLSearchParams).get('capture_method')).toBe('manual');expect((createInit.body as URLSearchParams).get('amount')).toBe('10000');
    const captured=await provider.capture({transactionId:'pi_test',amount:'20',currencyCode:'EGP',idempotencyKey:'capture-stripe-key'});
    expect(captured).toMatchObject({status:'PARTIALLY_CAPTURED',authorizedAmount:'100',capturedAmount:'20'});
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.stripe.com/v1/payment_intents/pi_test/capture');
    const captureInit=fetchMock.mock.calls[1][1]!;expect(captureInit.headers).toMatchObject({'Idempotency-Key':'capture-stripe-key'});expect((captureInit.body as URLSearchParams).get('amount_to_capture')).toBe('2000');expect((captureInit.body as URLSearchParams).get('final_capture')).toBe('false');expect(captureInit.signal).toBeDefined();
  });
  it('uses authoritative Stripe amounts and never infers settlement from pending authentication',async()=>{
    jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(intent({status:'requires_action',amount_capturable:0}))).mockResolvedValueOnce(json(intent({status:'succeeded',amount_received:10000,amount_capturable:0}))).mockResolvedValueOnce(json(intent({amount_received:10001})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    expect(await provider.retrieveLifecycle('pi_test')).toMatchObject({status:'PENDING',authorizedAmount:'0',capturedAmount:'0'});
    expect(await provider.retrieveLifecycle('pi_test')).toMatchObject({status:'PAID',authorizedAmount:'100',capturedAmount:'100'});
    await expect(provider.retrieveLifecycle('pi_test')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_AMOUNT_MISMATCH'});
  });
  it('voids an uncaptured Stripe authorization but blocks void of captured money',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(intent())).mockResolvedValueOnce(json(intent({status:'canceled',amount_capturable:0}))).mockResolvedValueOnce(json(intent({amount_received:2000,amount_capturable:8000})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    expect((await provider.void({transactionId:'pi_test',idempotencyKey:'void-stripe-key'})).status).toBe('VOIDED');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.stripe.com/v1/payment_intents/pi_test/cancel');expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({'Idempotency-Key':'void-stripe-key'});
    await expect(provider.void({transactionId:'pi_test',idempotencyKey:'void-captured-key'})).rejects.toMatchObject({code:'PAYMENT_INVALID_STATE'});expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('fails closed on provider errors, mismatched identity and unsupported authorization',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('private-network-detail')).mockResolvedValueOnce(json({error:{code:'declined'}},400)).mockResolvedValueOnce(json(intent({id:'pi_wrong'})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    await expect(provider.retrieveLifecycle('pi_test')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_UNAVAILABLE'});
    await expect(provider.capture({transactionId:'pi_test',amount:'1',currencyCode:'EGP',idempotencyKey:'reject-key'})).rejects.toMatchObject({code:'PAYMENT_PROVIDER_REJECTED'});
    await expect(provider.capture({transactionId:'pi_test',amount:'1',currencyCode:'EGP',idempotencyKey:'mismatch-key'})).rejects.toMatchObject({code:'PAYMENT_PROVIDER_TRANSACTION_MISMATCH'});
    const xpay=new XPayPaymentAdapter('test-api-key','test-webhook-secret','merchant-test','https://example.test/return');
    await expect(xpay.createPaymentAttempt(input)).rejects.toMatchObject({code:'PAYMENT_PROVIDER_STATE_UNSUPPORTED'});expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('preserves the default sale request contract used by existing invoice calls',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(json(intent({amount_capturable:0,status:'requires_payment_method'})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    await provider.createPaymentAttempt({amount:'100',currencyCode:'EGP',idempotencyKey:'invoice-sale-key'});
    expect((fetchMock.mock.calls[0][1]!.body as URLSearchParams).has('capture_method')).toBe(false);
  });
  it('makes Stripe void retry safe and rejects lookup identity or state drift',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValueOnce(json(intent({status:'canceled',amount_capturable:0}))).mockResolvedValueOnce(json(intent({id:'pi_other'}))).mockResolvedValueOnce(json(intent({status:'unexpected_provider_state'})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    expect((await provider.void({transactionId:'pi_test',idempotencyKey:'void-retry-key'})).status).toBe('VOIDED');expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(provider.retrieveLifecycle('pi_test')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_TRANSACTION_MISMATCH'});
    await expect(provider.retrieveLifecycle('pi_test')).rejects.toMatchObject({code:'PAYMENT_PROVIDER_STATE_UNSUPPORTED'});
  });
  it('uses currency precision for zero/three-digit currencies and rejects unsafe amounts',async()=>{
    const provider=sandbox();
    await expect(provider.createPaymentAttempt({...input,amount:'0'})).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
    const jpy=await provider.createPaymentAttempt({...input,amount:'100',currencyCode:'JPY',idempotencyKey:'jpy-key'});provider.authorize(jpy.transactionId);
    expect((await provider.capture({transactionId:jpy.transactionId,amount:'40',currencyCode:'JPY',idempotencyKey:'jpy-capture'})).capturedAmount).toBe('40');
    await expect(provider.capture({transactionId:jpy.transactionId,amount:'0.1',currencyCode:'JPY',idempotencyKey:'jpy-fraction'})).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
    const kwd=await provider.createPaymentAttempt({...input,amount:'0.123',currencyCode:'KWD',idempotencyKey:'kwd-key'});provider.authorize(kwd.transactionId);
    expect((await provider.capture({transactionId:kwd.transactionId,amount:'0.023',currencyCode:'KWD',idempotencyKey:'kwd-capture'})).capturedAmount).toBe('0.023');
    await expect(provider.createPaymentAttempt({...input,amount:'999999999999999999'})).rejects.toMatchObject({code:'PAYMENT_AMOUNT_INVALID'});
  });
  it('defaults Stripe captures to final unless multicapture is explicitly installed',async()=>{
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(json(intent({status:'succeeded',amount_received:2000,amount_capturable:0})));
    const provider=new StripePaymentAdapter('test-api-key','test-webhook-secret','merchant-test');
    expect(provider.capabilities().multicapture).toBe(false);
    expect(await provider.capture({transactionId:'pi_test',amount:'20',currencyCode:'EGP',idempotencyKey:'final-capture-key'})).toMatchObject({status:'PARTIALLY_CAPTURED',authorizedAmount:'20',capturedAmount:'20'});
    expect((fetchMock.mock.calls[0][1]!.body as URLSearchParams).get('final_capture')).toBe('true');
  });
});
