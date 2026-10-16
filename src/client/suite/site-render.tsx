import type { ReactNode } from 'react';
import { ConsentBanner } from './site-consent';

type Block = { key: string; type: string; props: Record<string, any>; responsive?: { hidden?: string[] } };
type Nav = { name: string; locale: string; items: { label: string; pageId?: string; externalUrl?: string; children?: Nav['items'] }[] };
export type RenderedPage = { siteId: string; releaseId: string; html: { lang: string; dir: string }; seo: { title: string | null; description: string | null; canonical: string; robots: string; alternates: { hreflang: string; href: string }[] };
  navigation: Nav[]; blocks: Block[]; scripts: { id: string; category: string; sourceHash: string }[]; translationFallback: boolean; cookiePolicyVersion: number };

const H = ({ level, children }: { level: number; children: ReactNode }) => { const Tag = (`h${Math.min(6, Math.max(1, level))}`) as 'h1'; return <Tag>{children}</Tag>; };
/** Declarative block rendering only: text is escaped by React; no raw HTML, no executable content. */
function BlockView({ block }: { block: Block }) {
  const p = block.props;
  switch (block.type) {
    case 'headline': return <H level={p.level ?? 1}>{p.text}</H>;
    case 'text': return <p style={{ fontSize: p.size === 'lg' ? 20 : p.size === 'sm' ? 14 : 16 }}>{p.text}</p>;
    case 'button': return <p><a href={p.href} style={{ display: 'inline-block', padding: '10px 18px', borderRadius: 8, background: p.variant === 'link' ? 'transparent' : '#1e688d', color: p.variant === 'link' ? '#1e688d' : '#fff', textDecoration: 'none' }}>{p.label}</a></p>;
    case 'spacer': return <div aria-hidden style={{ height: { sm: 12, md: 24, lg: 48, xl: 80 }[p.size as string] ?? 24 }} />;
    case 'columns': return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(200px,1fr))`, gap: 24 }}>{(p.columns ?? []).map((c: { heading?: string; text: string }, i: number) => <section key={i}>{c.heading && <h3>{c.heading}</h3>}<p>{c.text}</p></section>)}</div>;
    case 'image': return <figure><img src={`/api/v1/file-delivery/${p.fileId}`} alt={p.alt} width={p.width} style={{ maxWidth: '100%', height: 'auto' }} /></figure>;
    case 'unavailable': return <p role="status">This section is currently unavailable.</p>;
    case 'product': case 'cart': case 'checkout': case 'form': case 'contact_widget':
      return <div data-module-binding={p.bindingId} data-block={block.type}><p role="status">Loading {block.type.replace('_', ' ')}…</p></div>;
    default: return null;
  }
}
function Menu({ items }: { items: Nav['items'] }) {
  return <ul style={{ display: 'flex', gap: 16, listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }}>{items.map((i, n) => <li key={n}><a href={i.externalUrl ?? '#'}>{i.label}</a>{i.children?.length ? <Menu items={i.children} /> : null}</li>)}</ul>;
}
export function SiteView({ page }: { page: RenderedPage }) {
  return <div lang={page.html.lang} dir={page.html.dir} style={{ font: '16px/1.6 system-ui,sans-serif', color: '#192b3f', maxWidth: 1080, margin: '0 auto', padding: '24px 16px' }}>
    {page.navigation.map(n => <nav key={n.name + n.locale} aria-label={n.name}><Menu items={n.items} /></nav>)}
    <main>{page.blocks.filter(b => !b.responsive?.hidden?.includes('desktop')).map(b => <BlockView key={b.key} block={b} />)}</main>
    {page.translationFallback && <p><small>This page is shown in the site&apos;s default language.</small></p>}
    {/* Approved, consented scripts are delivered by the sandboxed loader (no same-origin access); listed here by hash only. */}
    <div hidden data-approved-scripts={page.scripts.map(s => s.id + ':' + s.sourceHash).join(',')} />
    <ConsentBanner siteId={page.siteId} policyVersion={page.cookiePolicyVersion} />
  </div>;
}
