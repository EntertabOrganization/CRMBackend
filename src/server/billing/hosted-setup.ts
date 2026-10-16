import { z } from 'zod';
import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError } from '../errors';
import { command, requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { audit, emitEvent, notFound } from '../platform/kernel';

async function stripe(path: string, key: string, form: URLSearchParams) {
  const secret = process.env.BILLING_STRIPE_SECRET_KEY;
  if (!secret) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Stripe billing credentials are not configured.', 503);
  let response: Response;
  try { response = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': key }, body: form, signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Hosted setup outcome is unknown; retry with the same idempotency key.', 503); }
  if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', 'Billing provider rejected hosted setup.', 502);
  return await response.json() as Record<string, unknown>;
}
async function xpaySetup(key: string, body: Record<string, unknown>) {
  const secret = process.env.BILLING_XPAY_SECRET_KEY;
  if (!secret) throw new AppError('DEPENDENCY_UNAVAILABLE', 'XPay billing credentials are not configured.', 503);
  let response: Response;
  try { response = await fetch('https://api.xpay.app/checkout/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Hosted setup outcome is unknown; retry with the same idempotency key.', 503); }
  if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', 'XPay rejected hosted setup.', 502);
  const result = await response.json() as Record<string, unknown>;
  if (result.mode !== 'setup') throw new AppError('PROVIDER_UNAVAILABLE', 'Provider returned a different checkout mode.', 502);
  return result;
}

/** Hosted card collection only. The browser return never marks an invoice paid or authorizes automatic charges. */
export async function hostedPaymentSetup(db: PrismaClient, actor: Principal, raw: unknown, requestId: string, subscriptionId?: string) {
  const input = z.strictObject({ accountId: z.uuid().optional(), providerId: z.enum(['stripe', 'xpay']).default('stripe'), idempotencyKey: z.string().min(8).max(128) }).parse(raw);
  requirePermission(actor, 'billing.payment.manage');
  const configured = process.env.APP_URL;
  let origin: URL;
  try { origin = new URL(configured ?? ''); if (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error(); }
  catch { throw new AppError('DEPENDENCY_UNAVAILABLE', 'Configure a trusted APP_URL for hosted billing setup.', 503); }
  return db.$transaction(async tx => {
    const current = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
    requirePermission(current, 'billing.payment.manage');
    const sub = subscriptionId ? await tx.billingSubscription.findFirst({ where: { id: z.uuid().parse(subscriptionId), workspaceId: actor.workspaceId } }) : null;
    if (subscriptionId && !sub) throw notFound('Subscription');
    const accountId = input.accountId ?? sub?.billingAccountId;
    if (!accountId || input.accountId && sub && sub.billingAccountId !== input.accountId) throw new AppError('VALIDATION_FAILED', 'A matching billing account is required.', 400);
    const account = await tx.billingAccount.findFirst({ where: { id: accountId, workspaceId: actor.workspaceId, status: 'ACTIVE', payerType: 'CUSTOMER' } });
    if (!account) throw notFound('Customer billing account');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-setup:' + account.id}))`;
    return command(tx, current, 'BILLING_HOSTED_SETUP', input.idempotencyKey, { ...input, accountId, subscriptionId: subscriptionId ?? null }, async () => {
      const fresh = await tx.billingAccount.findUniqueOrThrow({ where: { id: account.id } });
      const refs = fresh.providerCustomers as Record<string, string>;
      let customer = refs.stripe;
      if (input.providerId === 'stripe' && !customer) {
        const result = await stripe('customers', 'billing-customer:' + account.id, new URLSearchParams({ 'metadata[billing_account_id]': account.id, 'metadata[workspace_id]': actor.workspaceId }));
        customer = z.string().regex(/^cus_[A-Za-z0-9]+$/).parse(result.id);
        await tx.billingAccount.update({ where: { id: account.id }, data: { providerCustomers: { ...refs, stripe: customer } as Prisma.InputJsonValue } });
      }
      const providerKey = 'billing-setup:' + actor.workspaceId + ':' + actor.userId + ':' + input.idempotencyKey;
      const result = input.providerId === 'stripe' ? await stripe('checkout/sessions', providerKey, new URLSearchParams({ mode: 'setup', customer, currency: account.billingCurrency.toLowerCase(),
        success_url: new URL('/billing?setup=returned', origin).href, cancel_url: new URL('/billing?setup=cancelled', origin).href,
        'metadata[billing_account_id]': account.id, 'setup_intent_data[metadata][billing_account_id]': account.id })) : await xpaySetup(providerKey, {
          mode: 'setup', uiMode: 'hosted', currency: account.billingCurrency, customerCreation: 'always',
          ...(refs.xpay ? { customerId: refs.xpay } : { customerDetails: { email: (await tx.user.findUniqueOrThrow({ where: { id: actor.userId } })).email } }),
          afterCompletion: { type: 'redirect', redirect: { url: new URL('/billing?setup=returned', origin).href } }, cancelUrl: new URL('/billing?setup=cancelled', origin).href, metadata: { billing_account_id: account.id },
        });
      const url = z.url().parse(result.url);
      if (new URL(url).protocol !== 'https:' || new URL(url).hostname !== (input.providerId === 'stripe' ? 'checkout.stripe.com' : 'checkout.xpay.app')) throw new AppError('PROVIDER_UNAVAILABLE', 'Billing provider returned an invalid checkout destination.', 502);
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_HOSTED_SETUP_CREATED', resourceType: 'BillingAccount', resourceId: account.id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, eventType: 'BILLING_HOSTED_SETUP_CREATED', aggregateType: 'BillingAccount', aggregateId: account.id, payload: { accountId: account.id } });
      return { setupId: z.string().parse(result.id), accountId: account.id, providerId: input.providerId, checkoutUrl: url, status: 'AWAITING_CUSTOMER' };
    });
  }, { timeout: 60000 });
}

/** Only an authenticated provider lookup can confirm setup; no browser-supplied customer or card reference is trusted. */
export async function refreshHostedSetup(db: PrismaClient, actor: Principal, setupId: string, requestId: string) {
  requirePermission(actor, 'billing.payment.manage');
  z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).parse(setupId);
  const record = await db.idempotencyRecord.findFirst({ where: { workspaceId: actor.workspaceId, operation: 'BILLING_HOSTED_SETUP', response: { path: ['setupId'], equals: setupId } } });
  if (!record) throw notFound('Setup');
  const saved = record.response as { providerId: 'stripe' | 'xpay'; accountId: string };
  const key = saved.providerId === 'stripe' ? process.env.BILLING_STRIPE_SECRET_KEY : process.env.BILLING_XPAY_SECRET_KEY;
  if (!key) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Billing credentials are not configured.', 503);
  let response: Response;
  try { response = await fetch((saved.providerId === 'stripe' ? 'https://api.stripe.com/v1/checkout/sessions/' : 'https://api.xpay.app/checkout/sessions/') + encodeURIComponent(setupId), { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError('PROVIDER_UNAVAILABLE', 'Setup status is unavailable.', 502); }
  if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', 'Setup status is unavailable.', 502);
  const session = await response.json();
  if (session.id !== setupId || session.mode !== 'setup' || session.metadata?.billing_account_id !== saved.accountId) throw new AppError('PROVIDER_UNAVAILABLE', 'Setup identity does not match.', 502);
  const complete = session.status === 'complete' && (saved.providerId === 'stripe' ? session.payment_status : session.paymentStatus) === 'no_payment_required';
  if (!complete) return { setupId, status: session.status === 'expired' ? 'EXPIRED' : 'AWAITING_CUSTOMER' };
  const customer = z.string().min(1).max(200).parse(saved.providerId === 'stripe' ? session.customer : session.customerId);
  return db.$transaction(async tx => {
    const current = await resolvePrincipal(tx, actor.workspaceId, actor.userId); requirePermission(current, 'billing.payment.manage');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'billing-setup:' + saved.accountId}))`;
    const account = await tx.billingAccount.findFirst({ where: { id: saved.accountId, workspaceId: actor.workspaceId, payerType: 'CUSTOMER', status: 'ACTIVE' } });
    if (!account) throw notFound('Billing account');
    const refs = account.providerCustomers as Record<string, string>;
    if (refs[saved.providerId] !== customer) {
      await tx.billingAccount.update({ where: { id: account.id }, data: { providerCustomers: { ...refs, [saved.providerId]: customer } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'BILLING_PAYMENT_METHOD_SETUP_CONFIRMED', resourceType: 'BillingAccount', resourceId: account.id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, eventType: 'BILLING_PAYMENT_METHOD_SETUP_CONFIRMED', aggregateType: 'BillingAccount', aggregateId: account.id, payload: { accountId: account.id } });
    }
    return { setupId, status: 'COMPLETED' };
  });
}
