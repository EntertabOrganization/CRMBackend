import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { isAppError } from '@/src/server/errors';
import { sitesPublisher } from '@/src/server/sites/routes';
import { SiteView, type RenderedPage } from '@/src/client/suite/site-render';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Published-site delivery: the host (custom verified domain or managed subdomain) selects the active release. */
async function load({ params, searchParams }: Props) {
  const [{ path = [] }, query, h, c] = await Promise.all([params, searchParams, headers(), cookies()]);
  const raw: Record<string, string> = { path: '/' + path.map(encodeURIComponent).join('/'), consent: c.get('site_consent')?.value ?? '' };
  if (typeof query.lang === 'string') raw.lang = query.lang;
  if (typeof query.host === 'string') raw.host = query.host;
  try { return await sitesPublisher.renderPublic(raw, h.get('x-forwarded-host') ?? h.get('host'), h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'public'); }
  catch (error) { if (isAppError(error) && error.status === 404) notFound(); if (isAppError(error) && error.status === 410) return { gone: true as const }; throw error; }
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const page = await load(props);
  if ('gone' in page || 'redirect' in page) return { robots: 'noindex' };
  const p = page as unknown as RenderedPage;
  return { title: p.seo.title ?? undefined, description: p.seo.description ?? undefined, robots: p.seo.robots, alternates: { canonical: p.seo.canonical, languages: Object.fromEntries(p.seo.alternates.map(a => [a.hreflang, a.href])) } };
}
export default async function Page(props: Props) {
  const page = await load(props);
  if ('gone' in page) return <main style={{ padding: 32, font: '16px system-ui' }}><h1>This page was removed</h1></main>;
  if ('redirect' in page && page.redirect) { if (page.redirect.statusCode === 301) permanentRedirect(page.redirect.location); redirect(page.redirect.location); }
  return <SiteView page={page as unknown as RenderedPage} />;
}
