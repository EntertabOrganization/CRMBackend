'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Field, SignIn, useWorkspaceSession, type Row } from './kit';

/** Independent block edits merge on the server; the local edit buffer survives remote refreshes and conflicts. */
export function KnowledgeEditor({ articleId }: { articleId: string }) {
  const { session, setSession, api } = useWorkspaceSession('suite-knowledge-session');
  const [draft, setDraft] = useState<Row | null>(null), [selected, setSelected] = useState<Row | null>(null), [text, setText] = useState('');
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<{ body: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    try { const response = await api(`/knowledge/articles/${encodeURIComponent(articleId)}?view=draft`); setDraft(response.data); }
    catch (e) { setDraft(null); setError(e instanceof Error ? e.message : 'Draft is unavailable.'); }
  }, [api, articleId]);
  useEffect(() => { if (!session) return; void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [session, refresh]);
  async function submit(kind: 'REPLACE' | 'INSERT_AFTER' | 'DELETE') {
    if (!draft?.revision || busy) return;
    const baseRevisionId = selected?.baseRevisionId ?? draft.revision.id;
    const blockId = selected?.block.blockId ?? draft.revision.content.blocks.at(-1)?.blockId ?? null;
    const block = kind === 'REPLACE' ? { ...selected!.block, text } : { type: 'paragraph', text, links: [] };
    const body = { baseRevisionId, operations: [{ kind, blockId, ...(kind === 'DELETE' ? {} : { block }) }] };
    const serialized = JSON.stringify(body);
    if (pending.current?.body !== serialized) pending.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true); setError(''); setStatus('');
    try {
      const response = await api(`/knowledge/articles/${encodeURIComponent(articleId)}/collaborative-edits`, 'POST', body, { 'idempotency-key': pending.current.key });
      pending.current = null; setSelected(null); setText(''); setStatus(response.data.merged ? 'Saved and merged with other edits.' : 'Saved as a new draft revision.'); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed. Your edit is preserved.'); }
    finally { setBusy(false); }
  }
  if (!session) return <SignIn product="Knowledge" api={api} onSession={setSession} />;
  return <main className="spa-shell"><h1>{draft?.title ?? 'Article editor'}</h1><p>Draft changes appear here automatically. Publishing and review are separate actions.</p>
    <p role="status">{status}</p>{error && <p role="alert">{error}</p>}
    {draft && <><p>Revision {draft.revision?.versionNumber}</p><div>{draft.revision?.content.blocks.map((block: Row, i: number) => <section className="spa-card" key={block.blockId ?? i}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{block.text ?? block.caption ?? block.type}</p>
      {'text' in block && <button onClick={() => { setSelected({ block, baseRevisionId: draft.revision.id }); setText(block.text); setError(''); }}>Edit block</button>}
    </section>)}</div>
      <Field name={selected ? 'Edit selected block' : 'New paragraph'}><textarea rows={8} value={text} onChange={e => setText(e.target.value)} /></Field>
      <button disabled={busy || !text || !draft} onClick={() => submit(selected ? 'REPLACE' : 'INSERT_AFTER')}>Save draft edit</button>
      {selected && <><button disabled={busy} onClick={() => { setSelected(null); setText(''); }}>Discard local edit</button><button disabled={busy} onClick={() => { if (confirm('Delete this block?')) void submit('DELETE'); }}>Delete selected block</button></>}
    </>}
  </main>;
}
