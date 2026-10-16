'use client';
import { useEffect, useState } from 'react';

/** Opt-in banner: no optional category is active until the visitor chooses; the choice is stored per site. */
export function ConsentBanner({ siteId, policyVersion }: { siteId: string; policyVersion: number }) {
  const [open, setOpen] = useState(false), [error, setError] = useState('');
  useEffect(() => { setOpen(!document.cookie.split('; ').some(c => c.startsWith('site_consent='))); }, []);
  async function choose(categories: string[]) {
    setError('');
    try {
      const referralCode = categories.includes('MARKETING') ? new URLSearchParams(location.search).get('ref') : null;
      const policy = await fetch(`/api/v1/public/sites/${siteId}/consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorKey: visitorKey(), acceptedCategories: categories, policyVersion, ...(referralCode ? { referralCode } : {}) }) });
      if (!policy.ok) throw new Error((await policy.json()).error?.message ?? 'Could not save your choice.');
      document.cookie = `site_consent=${categories.join(',')}; path=/; max-age=${180 * 86400}; samesite=lax`;
      setOpen(false); location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your choice.'); }
  }
  if (!open) return null;
  return <aside role="dialog" aria-label="Cookie preferences" style={{ position: 'fixed', insetInline: 16, bottom: 16, background: '#fff', border: '1px solid #cbd6e3', borderRadius: 12, padding: 16, boxShadow: '0 6px 24px #0002' }}>
    <p>We use necessary cookies to run this site. With your permission we also use analytics and marketing cookies.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button onClick={() => choose([])}>Necessary only</button><button onClick={() => choose(['ANALYTICS'])}>Allow analytics</button><button onClick={() => choose(['ANALYTICS', 'MARKETING'])}>Allow all</button></div>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
function visitorKey() {
  const existing = document.cookie.split('; ').find(c => c.startsWith('site_visitor='))?.split('=')[1];
  if (existing) return existing;
  const key = crypto.randomUUID().replace(/-/g, '');
  document.cookie = `site_visitor=${key}; path=/; max-age=${180 * 86400}; samesite=lax`;
  return key;
}
