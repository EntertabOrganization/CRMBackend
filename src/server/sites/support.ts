import type { Site } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { assertNoExecutable, notFound, safeUrl, sha256 } from '../suite/kernel';
import { cleanFile } from '../suite/files-port';

const text = (max: number) => z.string().max(max);
const href = z.string().max(2000).transform(v => safeUrl(v, true));
/** Immutable, versioned block definitions. Props are typed declarative data; no functions, scripts or raw HTML. */
export const BLOCK_DEFINITIONS = {
  headline: { version: 1, schema: z.strictObject({ text: text(300), level: z.number().int().min(1).max(6).default(1), align: z.enum(['start', 'center', 'end']).default('start') }), capabilities: [] },
  text: { version: 1, schema: z.strictObject({ text: text(20000), size: z.enum(['sm', 'md', 'lg']).default('md') }), capabilities: [] },
  image: { version: 1, schema: z.strictObject({ fileId: z.uuid(), alt: text(300), width: z.number().int().min(16).max(4096).optional() }), capabilities: ['FILES'] },
  button: { version: 1, schema: z.strictObject({ label: text(120), href, variant: z.enum(['primary', 'secondary', 'link']).default('primary') }), capabilities: [] },
  spacer: { version: 1, schema: z.strictObject({ size: z.enum(['sm', 'md', 'lg', 'xl']).default('md') }), capabilities: [] },
  columns: { version: 1, schema: z.strictObject({ columns: z.array(z.strictObject({ heading: text(200).optional(), text: text(5000) })).min(1).max(4) }), capabilities: [] },
  shared: { version: 1, schema: z.strictObject({ sharedBlockId: z.uuid() }), capabilities: ['SHARED_BLOCK'] },
  form: { version: 1, schema: z.strictObject({ bindingId: z.uuid(), displayMode: z.enum(['INLINE', 'POPUP']).default('INLINE') }), capabilities: ['FORMS'] },
  product: { version: 1, schema: z.strictObject({ bindingId: z.uuid() }), capabilities: ['COMMERCE'] },
  cart: { version: 1, schema: z.strictObject({ bindingId: z.uuid() }), capabilities: ['COMMERCE'] },
  checkout: { version: 1, schema: z.strictObject({ bindingId: z.uuid() }), capabilities: ['COMMERCE'] },
  contact_widget: { version: 1, schema: z.strictObject({ bindingId: z.uuid() }), capabilities: ['CONTACT_CENTER'] },
  blog_list: { version: 1, schema: z.strictObject({ category: text(120).optional(), limit: z.number().int().min(1).max(50).default(10) }), capabilities: ['CMS'] },
} as const;
export type BlockKind = keyof typeof BLOCK_DEFINITIONS;
export type Block = { key: string; type: BlockKind; props: Record<string, unknown>; responsive?: Record<string, unknown> };
const RESPONSIVE = z.strictObject({ hidden: z.array(z.enum(['mobile', 'tablet', 'desktop'])).max(3).optional(), padding: z.enum(['none', 'sm', 'md', 'lg']).optional(), background: z.string().regex(/^#[0-9a-fA-F]{6}$|^var\(--[a-z0-9-]+\)$/).optional() });

/** Normalizes `{type, key?, props?|inline props}` blocks, validates against the catalog, sanitizes and checks file ownership. */
export async function validateBlockTree(tx: Tx, actor: Principal, raw: unknown): Promise<{ blocks: Block[] }> {
  const tree = z.object({ blocks: z.array(z.record(z.string(), z.unknown())).max(200) }).safeParse(raw);
  if (!tree.success) throw new AppError('VALIDATION_FAILED', 'Block tree must contain a blocks array.', 400, { fields: [{ field: 'blockTreeJson.blocks', reason: 'INVALID' }] });
  const seen = new Set<string>(), blocks: Block[] = [];
  for (const [i, item] of tree.data.blocks.entries()) {
    const { type, key, props, responsive, ...inline } = item as { type?: string; key?: string; props?: unknown; responsive?: unknown };
    if (typeof type !== 'string' || !(type in BLOCK_DEFINITIONS)) throw new AppError('VALIDATION_FAILED', 'Unknown block type.', 400, { fields: [{ field: `blocks[${i}].type`, reason: 'UNKNOWN_BLOCK' }] });
    assertNoExecutable(props ?? inline, `blocks[${i}]`);
    const def = BLOCK_DEFINITIONS[type as BlockKind];
    const parsed = (def.schema as z.ZodType).safeParse(props ?? inline);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Block properties are invalid.', 400, { fields: parsed.error.issues.map(issue => ({ field: `blocks[${i}].props.${issue.path.join('.')}`, reason: issue.code.toUpperCase() })) });
    const blockKey = typeof key === 'string' && /^[a-z0-9-]{1,40}$/.test(key) ? key : `${type}-${i + 1}`;
    if (seen.has(blockKey)) throw new AppError('VALIDATION_FAILED', 'Block keys must be unique.', 400, { fields: [{ field: `blocks[${i}].key`, reason: 'DUPLICATE' }] }); seen.add(blockKey);
    const r = responsive === undefined ? undefined : RESPONSIVE.safeParse(responsive);
    if (r && !r.success) throw new AppError('VALIDATION_FAILED', 'Responsive tokens are invalid.', 400, { fields: [{ field: `blocks[${i}].responsive`, reason: 'INVALID' }] });
    const value = parsed.data as Record<string, unknown>;
    if (type === 'image') await cleanFile(tx, actor, String(value.fileId)); // unscanned/foreign files are never made public
    if (type === 'shared' && !await tx.siteSharedBlock.findFirst({ where: { workspaceId: actor.workspaceId, id: String(value.sharedBlockId) } })) throw notFound('Shared block');
    if (['form', 'product', 'cart', 'checkout', 'contact_widget'].includes(type) && !await tx.siteModuleBinding.findFirst({ where: { workspaceId: actor.workspaceId, id: String(value.bindingId) } })) throw notFound('Module binding');
    blocks.push({ key: blockKey, type: type as BlockKind, props: value, ...(r?.data ? { responsive: r.data } : {}) });
  }
  return { blocks };
}
export function contentHash(value: unknown) { return sha256(JSON.stringify(value)); }

/** Subscription capability: full access while entitled or within the grace window; afterwards read/export only. */
export function sitesAccess(actor: Principal, permission: string) {
  const ent = actor.entitlements ?? {};
  if (ent.sites !== false) return;
  const graceDays = typeof ent.sitesGraceDays === 'number' ? ent.sitesGraceDays : 15;
  if (typeof ent.sitesExpiredAt === 'string' && new Date(ent.sitesExpiredAt).getTime() + graceDays * 86400000 > Date.now()) return;
  if (!['sites.site.read', 'sites.site.export'].includes(permission)) throw new AppError('PERMISSION_DENIED', 'Sites is read-only for this Workspace subscription.', 403);
}
export async function loadSite(tx: Tx, actor: Principal, id: string, permission: string, includeArchived = false): Promise<Site> {
  requirePermission(actor, permission); sitesAccess(actor, permission);
  const site = await tx.site.findFirst({ where: { workspaceId: actor.workspaceId, id } });
  if (!site || !await ownerVisible(tx, actor, site.createdByUserId, permission)) throw notFound('Site');
  if (site.archivedAt && !includeArchived) throw notFound('Site');
  return site;
}
export const PLATFORM_DOMAIN = (process.env.SITES_PLATFORM_DOMAIN ?? 'sites.truecrm.app').toLowerCase();
export const hostname = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const pageSlug = z.string().trim().toLowerCase().max(120).regex(/^(?:[a-z0-9؀-ۿ]+(?:-[a-z0-9؀-ۿ]+)*)?$/);
export const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
export const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'ckb', 'dv', 'yi']);
export function isRtl(value: string) { return RTL_LOCALES.has(value.split('-')[0]); }
