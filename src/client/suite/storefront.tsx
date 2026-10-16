'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, Table, type Row } from './kit';
import '../spa/style.css';

type Cart = { cartToken: string; items: Row[] };
type Checkout = { id: string; token: string; quote?: Row; order?: Row };
async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch('/api/v1' + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((json.error?.message ?? 'Request failed.') + (json.error?.code ? ` (${json.error.code})` : ''));
  return json.data;
}

/**
 * Public storefront: catalog, cart, server-quoted checkout (amounts are never computed in the browser),
 * and the separate customer realm (account login or one-time guest order link).
 */
export function Storefront({ slug }: { slug: string }) {
  const [products, setProducts] = useState<Row[]>([]), [cart, setCart] = useState<Cart | null>(null), [checkout, setCheckout] = useState<Checkout | null>(null);
  const [customer, setCustomer] = useState(''), [orders, setOrders] = useState<Row[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); } }
  useEffect(() => { void act(async () => setProducts((await call(`/public/stores/${encodeURIComponent(slug)}/products`)) ?? [])); }, [slug]);
  useEffect(() => { try { const c = sessionStorage.getItem('store-cart:' + slug); if (c) setCart(JSON.parse(c)); const s = sessionStorage.getItem('store-customer:' + slug); if (s) setCustomer(s); } catch { /* storage unavailable */ } }, [slug]);
  useEffect(() => { try { if (cart) sessionStorage.setItem('store-cart:' + slug, JSON.stringify(cart)); } catch { /* ignore */ } }, [cart, slug]);

  async function add(product: Row) {
    await act(async () => {
      const current = cart ?? { cartToken: (await call(`/public/stores/${encodeURIComponent(slug)}/carts`, 'POST', {})).cartToken, items: [] };
      const updated = await call(`/public/carts/${current.cartToken}/items`, 'POST', { productId: product.productId, ...(product.variantId ? { variantId: product.variantId } : {}), quantity: '1' });
      setCart({ cartToken: current.cartToken, items: updated?.items ?? [...current.items, { name: product.name, quantity: '1' }] }); setNotice(product.name + ' added to cart.');
    });
  }
  async function startCheckout(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget);
    await act(async () => {
      const session = await call(`/public/carts/${cart!.cartToken}/checkout-sessions`, 'POST', { customerInfo: { name: form.get('name'), email: form.get('email') }, payerType: 'PERSON',
        shippingInfo: { country: form.get('country'), region: form.get('region'), city: form.get('city'), line1: form.get('line1') } });
      const quote = await call(`/public/checkout-sessions/${session.id}/quote`, 'POST', { paymentMethodId: form.get('paymentMethodId') }, { 'x-checkout-token': session.checkoutSessionToken });
      setCheckout({ id: session.id, token: session.checkoutSessionToken, quote: { ...quote, paymentMethodId: String(form.get('paymentMethodId')) } });
    });
  }
  async function confirm() {
    if (!checkout?.quote) return;
    await act(async () => {
      // One idempotency key per confirmation attempt: retries of this click never create a second order.
      const key = sessionStorage.getItem('store-confirm:' + checkout.id) ?? crypto.randomUUID(); sessionStorage.setItem('store-confirm:' + checkout.id, key);
      const order = await call(`/public/checkout-sessions/${checkout.id}/confirm`, 'POST', { acceptedQuoteVersion: checkout.quote!.quoteVersion, paymentMethodId: checkout.quote!.paymentMethodId ?? 'OFFLINE' }, { 'x-checkout-token': checkout.token, 'idempotency-key': key });
      setCheckout({ ...checkout, order }); setCart(null); sessionStorage.removeItem('store-cart:' + slug);
      setNotice('Order received. Payment is confirmed only after the payment provider or staff verifies it.');
    });
  }
  async function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget);
    await act(async () => {
      const link = String(form.get('guestToken') ?? '').trim();
      const session = link ? await call('/public/order-access/exchange', 'POST', { token: link }) : await call(`/public/stores/${encodeURIComponent(slug)}/customers/login`, 'POST', { email: form.get('email'), password: form.get('password') });
      setCustomer(session.accessToken); sessionStorage.setItem('store-customer:' + slug, session.accessToken);
      setOrders((await call('/customer/orders', 'GET', undefined, { authorization: 'Bearer ' + session.accessToken }))?.data ?? []);
    });
  }
  return <main className="spa-shell" aria-busy={busy}>
    <header className="spa-header"><div><p className="spa-eyebrow">STORE</p><h1>{slug}</h1></div>{cart && <p>{cart.items.length} item(s) in cart</p>}</header>
    {error && <p role="alert" className="spa-error">{error}</p>}{notice && <p role="status" className="spa-success">{notice}</p>}
    <section className="spa-grid" aria-label="Products">{products.map(p => <article key={p.productId + (p.variantId ?? '')} className="spa-card"><h2>{p.name}</h2>{p.description && <p>{p.description}</p>}
      <p><strong>{p.price?.amount} {p.price?.currency}</strong></p><p>{p.available ? 'In stock' : p.backorderAllowed ? 'Available on backorder' : 'Out of stock'}</p>
      <button disabled={busy || (!p.available && !p.backorderAllowed)} onClick={() => add(p)}>Add to cart</button></article>)}{!products.length && <p>No products are published yet.</p>}</section>
    {cart && !checkout?.order && <form className="spa-card" onSubmit={startCheckout}><h2>Checkout</h2><div className="spa-grid">
      <Field name="Full name"><input name="name" required autoComplete="name" /></Field><Field name="Email"><input name="email" type="email" required autoComplete="email" /></Field>
      <Field name="Country (ISO)"><input name="country" required defaultValue="EG" maxLength={2} /></Field><Field name="Region"><input name="region" required defaultValue="EG-C" /></Field>
      <Field name="City"><input name="city" required autoComplete="address-level2" /></Field><Field name="Address"><input name="line1" required autoComplete="address-line1" /></Field>
      <Field name="Payment"><select name="paymentMethodId" defaultValue="OFFLINE"><option value="OFFLINE">Pay offline</option><option value="COD">Cash on delivery</option></select></Field></div>
      <button disabled={busy}>Get server quote</button></form>}
    {checkout?.quote && !checkout.order && <section className="spa-card"><h2>Review</h2><Table rows={(checkout.quote.lines ?? []) as Row[]} columns={['name', 'quantity', 'unitPrice', 'total']} />
      <p>Subtotal {checkout.quote.subtotal} · Tax {checkout.quote.tax} · Delivery {checkout.quote.delivery ?? '0'} · <strong>Total {checkout.quote.total} {checkout.quote.currency}</strong></p>
      <button disabled={busy} onClick={confirm}>Place order</button></section>}
    {checkout?.order && <section className="spa-card"><h2>Thank you</h2><p>Order {checkout.order.id} · status {checkout.order.status} · payment {checkout.order.paymentStatus}</p></section>}
    <section className="spa-card"><h2>My orders</h2>{customer ? <><Table rows={orders} columns={['id', 'status', 'paymentStatus', 'total', 'currency', 'createdAt']} /><button className="spa-secondary" onClick={() => { setCustomer(''); setOrders([]); sessionStorage.removeItem('store-customer:' + slug); }}>Sign out</button></>
      : <form onSubmit={signIn}><p>Sign in with your store account, or paste the one-time order link token from your email.</p><div className="spa-grid">
        <Field name="Email"><input name="email" type="email" autoComplete="username" /></Field><Field name="Password"><input name="password" type="password" autoComplete="current-password" /></Field>
        <Field name="Guest order link token"><input name="guestToken" /></Field></div><button disabled={busy}>Open my orders</button></form>}</section>
  </main>;
}
