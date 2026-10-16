'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import '../spa/style.css';

export type Row = Record<string, any>;
export type Envelope = { success?: boolean; data?: any; meta?: Row | null; error?: { code?: string; message?: string; details?: unknown } };
export type Session = { accessToken: string; refreshToken: string; user: Row; workspace: Row };
export class ApiError extends Error { constructor(message: string, readonly code?: string, readonly status?: number, readonly details?: unknown) { super(message); } }

/** Workspace session for an admin console (token in sessionStorage only; never in URLs). */
export function useWorkspaceSession(storageKey: string) {
  const [session, setSession] = useState<Session | null>(null);
  const ref = useRef(session); ref.current = session;
  useEffect(() => { try { const stored = sessionStorage.getItem(storageKey); if (stored) setSession(JSON.parse(stored)); } catch { sessionStorage.removeItem(storageKey); } }, [storageKey]);
  useEffect(() => { if (session) sessionStorage.setItem(storageKey, JSON.stringify(session)); else sessionStorage.removeItem(storageKey); }, [session, storageKey]);
  const api = useCallback(async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Envelope> => {
    const current = ref.current;
    const response = await fetch('/api/v1' + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(current ? { authorization: 'Bearer ' + current.accessToken, 'x-workspace-id': current.workspace.id } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let result: Envelope = {};
    try { result = text ? JSON.parse(text) : {}; } catch { result = { data: text }; }
    if (!response.ok) { if (response.status === 401 && current) setSession(null); throw new ApiError(result.error?.message ?? 'The request failed.', result.error?.code, response.status, result.error?.details); }
    return result;
  }, []);
  return { session, setSession, api };
}

export function Field({ name, children, hint }: { name: string; children: ReactNode; hint?: string }) {
  return <label className="spa-label"><span>{name}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function SignIn({ product, onSession, api }: { product: string; onSession: (s: Session) => void; api: (path: string, method?: string, body?: unknown) => Promise<Envelope> }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { const result = await api('/auth/signin', 'POST', { email, password }); if (!result.data?.workspace) throw new Error('Join a Workspace before opening ' + product + '.'); onSession(result.data); setPassword(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); } finally { setBusy(false); }
  }
  return <main className="spa-shell spa-signin"><div className="spa-card"><p className="spa-eyebrow">{product.toUpperCase()}</p><h1>Sign in to your Workspace</h1>
    <form onSubmit={submit}><Field name="Email"><input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
      <Field name="Password"><input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
      <button disabled={busy}>Sign in</button></form>{error && <p role="alert" className="spa-error">{error}</p>}</div></main>;
}

/** Declarative operator action: path params (`:id`) + typed body fields → one API call with an Idempotency-Key. */
export type ActionField = { name: string; label?: string; type?: 'text' | 'number' | 'checkbox' | 'json' | 'date' | 'datetime' | 'select' | 'textarea'; options?: string[]; required?: boolean; placeholder?: string; defaultValue?: string };
export type Action = { label: string; method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; fields?: ActionField[]; query?: ActionField[]; describe?: string; danger?: boolean; stepUp?: boolean; navigate?: boolean };

function convert(field: ActionField, raw: FormDataEntryValue | null, checked: boolean) {
  if (field.type === 'checkbox') return checked;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return undefined;
  if (field.type === 'number') return Number(value);
  if (field.type === 'json') return JSON.parse(value);
  if (field.type === 'datetime') return new Date(value).toISOString();
  return value;
}

export function ActionRunner({ action, api, context, onDone }: { action: Action; api: (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<Envelope>; context: Row; onDone?: (result: Envelope) => void }) {
  const params = useMemo(() => [...action.path.matchAll(/:(\w+)/g)].map(m => m[1]), [action.path]);
  const [result, setResult] = useState<Envelope | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(''); setResult(null);
    try {
      let path = action.path;
      for (const p of params) { const v = String(form.get('param:' + p) ?? '').trim(); if (!v) throw new Error(`${p} is required.`); path = path.replace(':' + p, encodeURIComponent(v)); }
      if (action.navigate) { window.location.assign(path); return; }
      const query = new URLSearchParams();
      for (const q of action.query ?? []) { const v = convert(q, form.get('query:' + q.name), form.get('query:' + q.name) === 'on'); if (v !== undefined) query.set(q.name, String(v)); }
      const body: Row = {};
      for (const f of action.fields ?? []) { const v = convert(f, form.get('body:' + f.name), form.get('body:' + f.name) === 'on'); if (v !== undefined) body[f.name] = v; }
      const assertion = String(form.get('step-up-assertion') ?? '').trim();
      if (action.stepUp && !assertion) throw new Error('A recent MFA assertion is required.');
      if (action.danger && !window.confirm('Confirm: ' + action.label + '?')) return;
      const assertionInput = e.currentTarget.elements.namedItem('step-up-assertion');
      if (assertionInput instanceof HTMLInputElement) assertionInput.value = '';
      const res = await api(path + (query.size ? '?' + query.toString() : ''), action.method, action.method === 'GET' || action.method === 'DELETE' && !action.fields?.length ? undefined : body, assertion ? { 'x-mfa-assertion': assertion } : undefined);
      setResult(res); onDone?.(res);
    } catch (err) { setError(err instanceof ApiError ? `${err.message}${err.code ? ' (' + err.code + ')' : ''}` : err instanceof Error ? err.message : 'The action failed.'); }
    finally { setBusy(false); }
  }
  const input = (prefix: string, f: ActionField) => {
    const name = prefix + f.name, initial = context[f.name] ?? f.defaultValue ?? '';
    if (f.type === 'checkbox') return <input name={name} type="checkbox" defaultChecked={f.defaultValue === 'true'} />;
    if (f.type === 'select') return <select name={name} defaultValue={initial} required={f.required}><option value="">Choose…</option>{f.options?.map(o => <option key={o}>{o}</option>)}</select>;
    if (f.type === 'json' || f.type === 'textarea') return <textarea name={name} rows={f.type === 'json' ? 4 : 3} placeholder={f.placeholder} defaultValue={typeof initial === 'string' ? initial : JSON.stringify(initial)} required={f.required} />;
    return <input name={name} type={({ number: 'number', date: 'date', datetime: 'datetime-local' } as Record<string, string>)[f.type ?? ''] ?? 'text'} step="any" placeholder={f.placeholder} defaultValue={initial} required={f.required} />;
  };
  return <form className="spa-card" onSubmit={submit} aria-busy={busy}>
    <h2>{action.label}</h2>{action.describe && <p>{action.describe}</p>}
    <div className="spa-grid">
      {params.map(p => <Field key={p} name={p}><input name={'param:' + p} required defaultValue={context[p] ?? ''} /></Field>)}
      {(action.query ?? []).map(q => <Field key={'q' + q.name} name={q.label ?? q.name}>{input('query:', q)}</Field>)}
      {(action.fields ?? []).map(f => <Field key={f.name} name={(f.label ?? f.name) + (f.required ? ' *' : '')}>{input('body:', f)}</Field>)}
      {action.stepUp && <Field name="MFA assertion" hint="Use a recent assertion from your MFA service. It is used only for this request."><input name="step-up-assertion" type="password" autoComplete="off" required /></Field>}
    </div>
    <button disabled={busy} className={action.danger ? 'spa-danger' : undefined}>{action.navigate ? 'Open' : action.method === 'GET' ? 'Load' : 'Submit'}</button>
    {error && <p role="alert" className="spa-error">{error}</p>}
    {result && <Result data={result.data} />}
  </form>;
}

export function Result({ data }: { data: unknown }) {
  const rows = Array.isArray(data) ? data : Array.isArray((data as Row)?.data) ? (data as Row).data : null;
  if (rows && rows.length && typeof rows[0] === 'object') return <Table rows={rows} />;
  return <output className="spa-success" aria-live="polite">{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</output>;
}

export function Table({ rows, onSelect, columns }: { rows: Row[]; onSelect?: (row: Row) => void; columns?: string[] }) {
  const cols = columns ?? [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => !/Sealed|Hash|Encrypted|secret/i.test(k)).slice(0, 8);
  const show = (v: unknown) => v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v);
  return <div style={{ overflowX: 'auto' }}><table><thead><tr>{cols.map(c => <th key={c} scope="col">{c}</th>)}{onSelect && <th />}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>{cols.map(c => <td key={c}>{show(r[c])}</td>)}{onSelect && <td><button type="button" className="spa-link" onClick={() => onSelect(r)}>Use</button></td>}</tr>)}</tbody></table></div>;
}

/** Console shell: sign-in, workspace header, sections of lists + actions, and a shared selection context. */
export type Section = { title: string; list?: { label: string; path: string; contextKey?: string }; actions: Action[] };
export function Console({ product, storageKey, sections }: { product: string; storageKey: string; sections: Section[] }) {
  const { session, setSession, api } = useWorkspaceSession(storageKey);
  const [tab, setTab] = useState(sections[0].title), [rows, setRows] = useState<Row[]>([]), [context, setContext] = useState<Row>({}), [error, setError] = useState(''), [version, setVersion] = useState(0);
  const section = sections.find(s => s.title === tab) ?? sections[0];
  useEffect(() => {
    if (!session || !section.list) { setRows([]); return; }
    const missing = [...section.list.path.matchAll(/:(\w+)/g)].map(m => m[1]).filter(k => !context[k]);
    if (missing.length) { setRows([]); setError(`Select ${missing.join(', ')} in another section first.`); return; }
    let live = true; setError('');
    api(section.list.path.replace(/:(\w+)/g, (_m, k: string) => encodeURIComponent(context[k] ?? ''))).then(r => { if (live) setRows(Array.isArray(r.data) ? r.data : []); }).catch(e => { if (live) { setRows([]); setError(e instanceof Error ? e.message : 'Could not load.'); } });
    return () => { live = false; };
  }, [session, section, api, version, context]);
  if (!session) return <SignIn product={product} api={api} onSession={setSession} />;
  return <main className="spa-shell">
    <header className="spa-header"><div><p className="spa-eyebrow">{product.toUpperCase()}</p><h1>{section.title}</h1><small>{session.workspace.name} · {session.user.email}</small></div>
      <div className="spa-inline"><button className="spa-secondary" onClick={() => setVersion(v => v + 1)}>Refresh</button><button className="spa-secondary" onClick={() => setSession(null)}>Sign out</button></div></header>
    <nav className="spa-tabs" aria-label={product + ' sections'}>{sections.map(s => <button key={s.title} aria-current={s.title === tab ? 'page' : undefined} onClick={() => setTab(s.title)}>{s.title}</button>)}</nav>
    {section.list && <section className="spa-card" aria-label={section.list.label}><h2>{section.list.label}</h2>{error ? <p role="alert" className="spa-error">{error}</p> : rows.length ? <Table rows={rows} onSelect={r => setContext(c => ({ ...c, [section.list!.contextKey ?? 'id']: r.id, id: r.id }))} /> : <p>No records yet.</p>}</section>}
    {Object.keys(context).length > 0 && <p className="spa-success">Selected: {Object.entries(context).map(([k, v]) => `${k}=${v}`).join(' · ')}</p>}
    {section.actions.map(a => <ActionRunner key={a.label} action={a} api={api} context={context} onDone={() => setVersion(v => v + 1)} />)}
  </main>;
}
