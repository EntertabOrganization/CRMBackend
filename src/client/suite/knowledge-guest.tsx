'use client';
import { useEffect, useRef, useState } from 'react';
import '../spa/style.css';

export function KnowledgeGuest() {
  const invitation = useRef<{ token: string; email: string } | null>(null);
  const session = useRef<string | null>(null);
  const [ready, setReady] = useState(false), [article, setArticle] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('token') && params.get('email')) invitation.current = { token: params.get('token')!, email: params.get('email')! };
    history.replaceState(null, '', location.pathname);
    setReady(!!invitation.current);
  }, []);
  async function open() {
    setBusy(true); setError('');
    try {
      if (!session.current) {
        const response = await fetch('/api/v1/public/knowledge/guest-invitations/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invitation.current) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message ?? 'Invitation could not be accepted.');
        session.current = result.data.guestSession;
        invitation.current = null;
      }
      const response = await fetch('/api/v1/public/knowledge/guest/article', { cache: 'no-store', headers: { authorization: 'Bearer ' + session.current } });
      const result = await response.json();
      if (!response.ok) { setArticle(null); throw new Error(result.error?.message ?? 'Article is unavailable.'); }
      setArticle(result.data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open invitation.'); }
    finally { setBusy(false); }
  }
  return <main className="spa-shell"><h1>{article?.title ?? 'Knowledge invitation'}</h1>
    <p>This invitation gives access to one published article.</p>
    <button disabled={busy || !ready} onClick={open}>{busy ? 'Loading…' : article ? 'Refresh article' : 'Accept invitation and read'}</button>
    {!ready && <p>Open the invitation link from your email.</p>}
    {error && <p role="alert">{error}</p>}
    {article && <article>{article.content.blocks.map((b: any, i: number) => <section key={i}>
      {b.unavailable ? <p>Attachment unavailable to guests.</p> : b.type === 'heading' ? <h2>{b.text}</h2> : b.type === 'list' || b.type === 'checklist' ? <ul>{b.items.map((item: any, j: number) => <li key={j}>{typeof item === 'string' ? item : item.text}</li>)}</ul> : b.type === 'table' ? <table><tbody>{b.rows.map((row: string[], j: number) => <tr key={j}>{row.map((cell, k) => <td key={k}>{cell}</td>)}</tr>)}</tbody></table> : <p style={{ whiteSpace: 'pre-wrap' }}>{b.text}</p>}
    </section>)}</article>}
  </main>;
}
