'use client';
import { useEffect, useState } from 'react';
import { SignIn, useWorkspaceSession } from './kit';

export function AiStream({ runId }: { runId: string }) {
  const { session, setSession, api } = useWorkspaceSession('suite-ai-session');
  const [text, setText] = useState(''), [status, setStatus] = useState('Connecting'), [error, setError] = useState(''), [generation, reconnect] = useState(0);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setError(''); setText(''); setStatus('Connecting');
    void (async () => {
      try {
        const response = await fetch(`/api/v1/ai/runs/${encodeURIComponent(runId)}/stream`, { headers: { authorization: 'Bearer ' + session.accessToken, 'x-workspace-id': session.workspace.id }, signal: controller.signal, cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error('Run is unavailable or access changed.');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!controller.signal.aborted) {
          const next = await reader.read(); if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = event.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const value = JSON.parse(data.slice(6));
            if (value.reason) { setText(''); throw new Error('Access changed or the stream is unavailable.'); }
            setStatus(value.status);
            if (value.text !== null) setText(value.text);
            if (value.result?.text) setText(value.result.text);
            if (value.errorCode) setError(value.errorCode);
          }
        }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Stream failed.'); }
    })();
    return () => controller.abort();
  }, [session, runId, generation]);
  if (!session) return <SignIn product="AI CoPilot" api={api} onSession={setSession} />;
  return <main className="spa-shell"><h1>AI run</h1><p role="status">{status}</p><p>Plain-text responses appear as they arrive. Structured responses, tools and retrieved sources are validated before they are available in run details.</p>
    {error && <p role="alert">{error}</p>}<pre style={{ whiteSpace: 'pre-wrap' }}>{text}</pre><button onClick={() => reconnect(n => n + 1)}>Reconnect</button>
    <button onClick={() => void api(`/ai/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}).catch(e => setError(e.message))}>Cancel run</button>
  </main>;
}
