import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { readCleanFile } from '../suite/files-port';
import { blocksToDocx, decodeEntities, DOCX_MIME, htmlToBlocks, readZip } from '../collab/files/document-render';
import { enqueueJob, registerJob } from '../platform/events-service';
import { audit, emitEvent, notFound, paged } from '../platform/kernel';
import { decrypt, encrypt } from '../suite/kernel';
import { articleLevel, articleSlug, assertKnowledgeWrite, assignAnchors, CONTENT, LEVELS, loadArticle, loadSpace, normalizeContent, rebuildPaths, sha, type Block, type Content, type Tx } from './support';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024, MAX_ROWS = 500, EXPORT_TTL_HOURS = 24, BATCH = 20;
const FORMATS = { MARKDOWN: { mimes: ['text/markdown', 'text/x-markdown', 'text/plain'], ext: /\.(md|markdown)$/i }, HTML: { mimes: ['text/html'], ext: /\.html?$/i }, DOCX: { mimes: [DOCX_MIME], ext: /\.docx$/i } } as const;
type Doc = { title: string; blocks: Block[] };

// ------------------------------------------------------------------ parsers (untrusted input becomes inert text blocks)
function parseMarkdown(text: string, fallbackTitle: string): Doc[] {
  const docs: Doc[] = []; let cur: Doc | null = null, para: string[] = [], code: string[] | null = null, lang = '';
  const target = () => (cur ??= { title: fallbackTitle, blocks: [] }, cur);
  const flush = () => { if (para.length) { target().blocks.push({ type: 'paragraph', text: para.join(' ').trim(), links: [] }); para = []; } };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) { if (/^```/.test(raw)) { target().blocks.push({ type: 'code', language: lang, text: code.join('\n') }); code = null; } else code.push(raw); continue; }
    const line = raw.trimEnd(); let m: RegExpMatchArray | null;
    if ((m = line.match(/^```\s*([a-z0-9+#-]{0,30})/i))) { flush(); code = []; lang = m[1].toLowerCase(); }
    else if ((m = line.match(/^#\s+(.+)/))) { flush(); if (cur) docs.push(cur); cur = { title: m[1].trim().slice(0, 200), blocks: [] }; }
    else if ((m = line.match(/^(#{2,5})\s+(.+)/))) { flush(); target().blocks.push({ type: 'heading', level: Math.min(4, m[1].length - 1), text: m[2].trim().slice(0, 300) }); }
    else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/))) { flush(); const last = target().blocks.at(-1); const item = { text: m[2], checked: m[1].toLowerCase() === 'x' }; if (last?.type === 'checklist') last.items.push(item); else target().blocks.push({ type: 'checklist', items: [item] }); }
    else if ((m = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)/))) { flush(); const ordered = !!m[2], last = target().blocks.at(-1); if (last?.type === 'list' && last.ordered === ordered) last.items.push(m[3]); else target().blocks.push({ type: 'list', ordered, items: [m[3]] }); }
    else if ((m = line.match(/^>\s?(.*)/))) { flush(); target().blocks.push({ type: 'quote', text: m[1] }); }
    else if (/^\|.*\|$/.test(line)) { flush(); const cells = line.slice(1, -1).split('|').map(c => c.trim()); const last = target().blocks.at(-1); if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; if (last?.type === 'table') last.rows.push(cells); else target().blocks.push({ type: 'table', header: cells, rows: [] }); }
    else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  if (code) target().blocks.push({ type: 'code', language: lang, text: code.join('\n') });
  flush(); if (cur) docs.push(cur);
  return docs;
}
function fromLegacyBlocks(blocks: ReturnType<typeof htmlToBlocks>, fallbackTitle: string): Doc[] {
  const docs: Doc[] = []; let cur: Doc | null = null;
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level === 1) { if (cur) docs.push(cur); cur = { title: b.text.slice(0, 200), blocks: [] }; continue; }
    cur ??= { title: fallbackTitle, blocks: [] };
    if (b.kind === 'heading') cur.blocks.push({ type: 'heading', level: Math.min(4, Math.max(1, b.level - 1)), text: b.text.slice(0, 300) });
    else if (b.kind === 'item') { const last = cur.blocks.at(-1); if (last?.type === 'list') last.items.push(b.text); else cur.blocks.push({ type: 'list', ordered: false, items: [b.text] }); }
    else cur.blocks.push({ type: 'paragraph', text: b.text, links: [] });
  }
  if (cur) docs.push(cur);
  return docs;
}
/** DOCX via the shared hardened ZIP reader; heading styles map to article/section boundaries. Corrupt packages fail the job (06 AC05). */
function parseDocx(bytes: Buffer, fallbackTitle: string): Doc[] {
  const entries = readZip(bytes);
  const document = entries.find(e => e.name === 'word/document.xml');
  if (!document) throw new AppError('VALIDATION_FAILED', 'The DOCX package has no document body.', 400);
  const blocks: ReturnType<typeof htmlToBlocks> = [];
  for (const p of document.data.toString('utf8').matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const text = decodeEntities([...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('')).trim();
    if (!text) continue;
    const style = p[0].match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? '';
    const heading = style.match(/^(?:Heading|Title)(\d?)$/i);
    const list = /<w:numPr>/.test(p[0]);
    blocks.push({ kind: heading ? 'heading' : list ? 'item' : 'paragraph', text, level: heading ? Number(heading[1] || 1) : 0 });
  }
  return fromLegacyBlocks(blocks, fallbackTitle);
}
type LegacyBlock = ReturnType<typeof htmlToBlocks>[number];
function docxBlocks(docs: Array<{ title: string; content: Content }>): LegacyBlock[] {
  const out: LegacyBlock[] = [];
  for (const d of docs) {
    out.push({ kind: 'heading', text: d.title, level: 1 });
    for (const b of d.content.blocks) {
      if (b.type === 'heading') out.push({ kind: 'heading', text: b.text, level: b.level + 1 });
      else if (b.type === 'list') for (const t of b.items) out.push({ kind: 'item', text: t, level: 0 });
      else if (b.type === 'checklist') for (const t of b.items) out.push({ kind: 'item', text: (t.checked ? '[x] ' : '[ ] ') + t.text, level: 0 });
      else if ('text' in b) out.push({ kind: 'paragraph', text: b.text, level: 0 });
    }
  }
  return out;
}
function toMarkdown(title: string, content: Content) {
  const lines = [`# ${title}`, ''];
  for (const b of content.blocks) switch (b.type) {
    case 'heading': lines.push('#'.repeat(b.level + 1) + ' ' + b.text, ''); break;
    case 'paragraph': lines.push(b.text, ''); break;
    case 'list': b.items.forEach((t, i) => lines.push(`${b.ordered ? i + 1 + '.' : '-'} ${t}`)); lines.push(''); break;
    case 'checklist': b.items.forEach(t => lines.push(`- [${t.checked ? 'x' : ' '}] ${t.text}`)); lines.push(''); break;
    case 'quote': lines.push('> ' + b.text, ''); break;
    case 'code': lines.push('```' + b.language, b.text, '```', ''); break;
    case 'table': lines.push('| ' + b.header.join(' | ') + ' |', '| ' + b.header.map(() => '---').join(' | ') + ' |', ...b.rows.map(r => '| ' + r.join(' | ') + ' |'), ''); break;
    case 'callout': lines.push(`> **${b.tone}:** ${b.text}`, ''); break;
    default: break; // files are exported only as references the requester may open in-app
  }
  return lines.join('\n');
}
const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function toHtml(title: string, content: Content) {
  const body = content.blocks.map(b => b.type === 'heading' ? `<h${b.level + 1} id="${esc(b.anchor ?? '')}">${esc(b.text)}</h${b.level + 1}>` : b.type === 'paragraph' ? `<p>${esc(b.text)}</p>` : b.type === 'list' ? `<${b.ordered ? 'ol' : 'ul'}>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`
    : b.type === 'checklist' ? `<ul>${b.items.map(i => `<li>${i.checked ? '☑' : '☐'} ${esc(i.text)}</li>`).join('')}</ul>` : b.type === 'quote' || b.type === 'callout' ? `<blockquote>${esc(b.text)}</blockquote>` : b.type === 'code' ? `<pre><code>${esc(b.text)}</code></pre>`
    : b.type === 'table' ? `<table><thead><tr>${b.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '').join('\n');
  return `<article><h1>${esc(title)}</h1>\n${body}</article>`;
}

async function createImportedArticle(tx: Tx, actor: Principal, spaceId: string, title: string, content: Content) {
  let slug = articleSlug(title) || 'article', i = 1; const base = slug;
  while (await tx.knowledgeArticle.findFirst({ where: { workspaceId: actor.workspaceId, spaceId, parentArticleId: null, slug: { equals: slug, mode: 'insensitive' }, status: { notIn: ['RECYCLED', 'PURGED'] } } })) slug = `${base}-${++i}`;
  const article = await tx.knowledgeArticle.create({ data: { workspaceId: actor.workspaceId, spaceId, title, slug, ownerUserId: actor.userId } });
  const sections = assignAnchors(content, []);
  const normalized = normalizeContent(content, 1_000_000);
  const rev = await tx.knowledgeRevision.create({ data: { workspaceId: actor.workspaceId, articleId: article.id, versionNumber: 1, title, contentJson: normalized.content, contentHash: normalized.hash, authorUserId: actor.userId, safetyScan: normalized.safety } });
  for (const s of sections) await tx.knowledgeSection.create({ data: { revisionId: rev.id, anchor: s.anchor, headingLevel: s.level, order: s.order, title: s.title } });
  await tx.knowledgeArticle.update({ where: { id: article.id }, data: { currentDraftRevisionId: rev.id } });
  await rebuildPaths(tx, article.id);
  return { article, renamed: i > 1 };
}

/** Resumable import: each row commits with its outcome, so retries continue from the cursor without duplicates (06 AC02). */
registerJob({ type: 'knowledge.import', ownerModule: 'knowledge', maxAttempts: 5, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const job = await prisma.knowledgeImportJob.findUnique({ where: { id: String(ctx.payload.jobId) } });
  if (!job || !['RUNNING'].includes(job.status)) return { skipped: true };
  const actor = await resolvePrincipal(prisma, job.workspaceId, job.requestedBy); // destination ACL applies with the requester's live rights
  for (;;) {
    const rows = await prisma.knowledgeImportRow.findMany({ where: { jobId: job.id, outcome: 'PENDING' }, orderBy: { ordinal: 'asc' }, take: BATCH });
    if (!rows.length) break;
    for (const row of rows) await prisma.$transaction(async tx => {
      const fresh = await tx.knowledgeImportRow.findUniqueOrThrow({ where: { id: row.id } }); if (fresh.outcome !== 'PENDING') return;
      try {
        await loadSpace(tx, actor, job.targetSpaceId, 'EDIT');
        const content = CONTENT.parse(row.content);
        const { article, renamed } = await createImportedArticle(tx, actor, job.targetSpaceId, row.title, content);
        await tx.knowledgeImportRow.update({ where: { id: row.id }, data: { outcome: renamed ? 'CREATED_RENAMED' : 'CREATED', targetArticleId: article.id } });
      } catch (error) {
        await tx.knowledgeImportRow.update({ where: { id: row.id }, data: { outcome: 'FAILED', validationErrors: [{ code: error instanceof AppError ? error.code : 'IMPORT_ROW_FAILED', message: error instanceof AppError ? error.message : 'Row could not be imported.' }] } });
      }
      await tx.knowledgeImportJob.update({ where: { id: job.id }, data: { cursor: row.ordinal + 1, progress: { increment: 1 } } });
    }, { timeout: 60000 });
  }
  const failed = await prisma.knowledgeImportRow.count({ where: { jobId: job.id, outcome: 'FAILED' } }), total = await prisma.knowledgeImportRow.count({ where: { jobId: job.id } });
  await prisma.$transaction(async tx => {
    await tx.knowledgeImportJob.update({ where: { id: job.id }, data: { status: failed === 0 ? 'COMPLETE' : failed === total ? 'FAILED' : 'PARTIAL' } });
    await emitEvent(tx, { workspaceId: job.workspaceId, eventType: 'KNOWLEDGE_IMPORT_FINISHED', aggregateType: 'KnowledgeImportJob', aggregateId: job.id, actorType: 'SERVICE', payload: { total, failed } });
  });
  return { total, failed };
} });
/** Export renders only content the requester can view NOW (06 AC03); output is sealed and expires. */
registerJob({ type: 'knowledge.export', ownerModule: 'knowledge', maxAttempts: 3, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const job = await prisma.knowledgeExportJob.findUnique({ where: { id: String(ctx.payload.jobId) } });
  if (!job || job.status !== 'QUEUED') return { skipped: true };
  await prisma.knowledgeExportJob.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
  try {
    const actor = await resolvePrincipal(prisma, job.workspaceId, job.requesterId);
    const req = job.request as { articleIds?: string[]; spaceId?: string };
    const candidates = await prisma.knowledgeArticle.findMany({ where: { workspaceId: job.workspaceId, status: { in: ['PUBLISHED', 'ARCHIVED'] }, publishedRevisionId: { not: null }, ...(req.articleIds?.length ? { id: { in: req.articleIds } } : {}), ...(req.spaceId ? { spaceId: req.spaceId } : {}) }, orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }], take: 2000 });
    const docs: Array<{ id: string; title: string; content: Content }> = [];
    for (const a of candidates) {
      if (await prisma.$transaction(tx => articleLevel(tx, actor, a)) < LEVELS.VIEW) continue;
      const rev = await prisma.knowledgeRevision.findUniqueOrThrow({ where: { id: a.publishedRevisionId! } });
      docs.push({ id: a.id, title: rev.title, content: rev.contentJson as Content });
    }
    const output = job.format === 'JSON' ? JSON.stringify(docs) : job.format === 'HTML' ? docs.map(d => toHtml(d.title, d.content)).join('\n<hr/>\n')
      : job.format === 'DOCX' ? blocksToDocx(docxBlocks(docs)).toString('base64')
      : docs.map(d => toMarkdown(d.title, d.content)).join('\n\n---\n\n');
    await prisma.$transaction(async tx => {
      await tx.knowledgeExportJob.update({ where: { id: job.id }, data: { status: 'READY', articleIds: docs.map(d => d.id), outputSealed: encrypt(output) } });
      await emitEvent(tx, { workspaceId: job.workspaceId, eventType: 'KNOWLEDGE_EXPORT_READY', aggregateType: 'KnowledgeExportJob', aggregateId: job.id, actorType: 'SERVICE', payload: { articles: docs.length } });
    });
    return { articles: docs.length };
  } catch (error) { await prisma.knowledgeExportJob.update({ where: { id: job.id }, data: { status: 'FAILED' } }); if (!(error instanceof AppError)) throw error; return { failed: true }; }
} });

/** Import/export and templates (28/06). */
export class KnowledgeExchangeService {
  constructor(private readonly db: PrismaClient) {}
  /** Preview validates MIME/extension, size, hierarchy and collisions before creating anything (06 rule 3). */
  async createImport(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.import'); assertKnowledgeWrite(actor);
    const input = z.strictObject({ fileId: z.uuid(), format: z.enum(['MARKDOWN', 'HTML', 'DOCX']), targetSpaceId: z.uuid(), mode: z.literal('PREVIEW').default('PREVIEW') }).parse(raw);
    return this.db.$transaction(async tx => {
      await loadSpace(tx, actor, input.targetSpaceId, 'EDIT');
      const { file, version, bytes } = await readCleanFile(tx, actor, input.fileId, MAX_IMPORT_BYTES);
      const spec = FORMATS[input.format], name = file.name, mime = version.mimeType || file.mimeType;
      if (!spec.ext.test(name) || mime && !(spec.mimes as readonly string[]).includes(mime)) throw new AppError('VALIDATION_FAILED', 'File type does not match the import format.', 400, { fields: [{ field: 'format', reason: 'MIME_EXTENSION_MISMATCH' }] });
      const fallback = name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Imported article';
      const job = await tx.knowledgeImportJob.create({ data: { workspaceId: actor.workspaceId, requestedBy: actor.userId, fileId: file.id, format: input.format, targetSpaceId: input.targetSpaceId } });
      let docs: Doc[];
      try { docs = input.format === 'MARKDOWN' ? parseMarkdown(bytes.toString('utf8'), fallback) : input.format === 'HTML' ? fromLegacyBlocks(htmlToBlocks(bytes.toString('utf8')), fallback) : parseDocx(bytes, fallback); }
      catch (error) {
        await tx.knowledgeImportJob.update({ where: { id: job.id }, data: { status: 'FAILED', preview: { error: error instanceof AppError ? error.message : 'The file could not be parsed.' } } });
        return { jobId: job.id, status: 'FAILED', error: error instanceof AppError ? error.code : 'IMPORT_PARSE_FAILED' };
      }
      if (docs.length > MAX_ROWS) throw new AppError('VALIDATION_FAILED', `Import is limited to ${MAX_ROWS} articles per file.`, 400);
      let ok = 0, invalid = 0, collisions = 0;
      for (const [i, d] of docs.entries()) {
        const errors: Array<{ code: string; message: string }> = []; let content: Content | null = null;
        try { content = normalizeContent({ blocks: d.blocks }, 1_000_000).content; } catch (error) { errors.push({ code: 'INVALID_CONTENT', message: error instanceof Error ? error.message.slice(0, 300) : 'Invalid content' }); }
        if (!d.title.trim()) errors.push({ code: 'TITLE_REQUIRED', message: 'Article title is empty.' });
        const collision = await tx.knowledgeArticle.findFirst({ where: { workspaceId: actor.workspaceId, spaceId: input.targetSpaceId, parentArticleId: null, slug: { equals: articleSlug(d.title), mode: 'insensitive' }, status: { notIn: ['RECYCLED', 'PURGED'] } } });
        if (collision) collisions++;
        await tx.knowledgeImportRow.create({ data: { jobId: job.id, ordinal: i, sourcePath: `${name}#${i + 1}`, title: d.title.trim().slice(0, 200) || fallback, content: content ?? undefined, outcome: errors.length ? 'INVALID' : 'PENDING', validationErrors: [...errors, ...(collision ? [{ code: 'PATH_COLLISION', message: 'An article with this path exists; the import will be renamed.' }] : [])] } });
        if (errors.length) invalid++; else ok++;
      }
      const preview = { articles: docs.length, valid: ok, invalid, collisions, unsupported: [] as string[] };
      await tx.knowledgeImportJob.update({ where: { id: job.id }, data: { status: 'PREVIEWED', preview } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_IMPORT_PREVIEWED', resourceType: 'KnowledgeImportJob', resourceId: job.id, after: preview, requestId });
      return { jobId: job.id, status: 'PREVIEWED', preview };
    });
  }
  async executeImport(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.import'); assertKnowledgeWrite(actor);
    const input = z.strictObject({ idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    return this.db.$transaction(async tx => {
      const job = await tx.knowledgeImportJob.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, requestedBy: actor.userId } }); if (!job) throw notFound('Import job');
      if (job.status === 'RUNNING' || ['COMPLETE', 'PARTIAL'].includes(job.status)) { if (job.idempotencyKey !== input.idempotencyKey) throw new AppError('IDEMPOTENCY_CONFLICT', 'Import already started with another key.', 409); return job; }
      if (job.status !== 'PREVIEWED') throw new AppError('INVALID_STATE_TRANSITION', `Import is ${job.status}.`, 409);
      const updated = await tx.knowledgeImportJob.update({ where: { id: job.id }, data: { status: 'RUNNING', idempotencyKey: input.idempotencyKey } });
      await enqueueJob(tx, { type: 'knowledge.import', ownerModule: 'knowledge', workspaceId: actor.workspaceId, payload: { jobId: job.id }, idempotencyKey: 'kb-import:' + job.id });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_IMPORT_STARTED', resourceType: 'KnowledgeImportJob', resourceId: job.id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'KNOWLEDGE_IMPORT_STARTED', aggregateType: 'KnowledgeImportJob', aggregateId: job.id, actorId: actor.userId, payload: {} });
      return updated;
    });
  }
  async getImport(actor: Principal, id: string) {
    requirePermission(actor, 'knowledge.import');
    const job = await this.db.knowledgeImportJob.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, requestedBy: actor.userId } }); if (!job) throw notFound('Import job');
    const rows = await this.db.knowledgeImportRow.findMany({ where: { jobId: job.id }, orderBy: { ordinal: 'asc' }, select: { ordinal: true, sourcePath: true, title: true, outcome: true, targetArticleId: true, validationErrors: true } });
    return { ...job, rows };
  }
  async cancelImport(actor: Principal, id: string) {
    requirePermission(actor, 'knowledge.import');
    const r = await this.db.knowledgeImportJob.updateMany({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, requestedBy: actor.userId, status: { in: ['UPLOADED', 'PREVIEWED'] } }, data: { status: 'CANCELLED' } });
    if (!r.count) throw new AppError('INVALID_STATE_TRANSITION', 'Only previewed imports can be cancelled.', 409);
    return { id, status: 'CANCELLED' };
  }
  async createExport(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.export');
    const input = z.strictObject({ articleIds: z.array(z.uuid()).max(2000).optional(), spaceId: z.uuid().optional(), format: z.enum(['MARKDOWN', 'HTML', 'JSON', 'DOCX']) }).parse(raw);
    if (!input.articleIds?.length && !input.spaceId) throw new AppError('VALIDATION_FAILED', 'Choose articles or a space to export.', 400);
    return this.db.$transaction(async tx => {
      if (input.spaceId) await loadSpace(tx, actor, input.spaceId, 'VIEW');
      const job = await tx.knowledgeExportJob.create({ data: { workspaceId: actor.workspaceId, requesterId: actor.userId, scopeHash: sha(JSON.stringify(input)), request: input, format: input.format, expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600000) } });
      await enqueueJob(tx, { type: 'knowledge.export', ownerModule: 'knowledge', workspaceId: actor.workspaceId, payload: { jobId: job.id }, idempotencyKey: 'kb-export:' + job.id });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_EXPORT_REQUESTED', resourceType: 'KnowledgeExportJob', resourceId: job.id, after: input, requestId });
      return { jobId: job.id, status: job.status };
    });
  }
  /** Download re-checks every included article; any revoked access fails the download (06 AC04). */
  async downloadExport(actor: Principal, id: string) {
    requirePermission(actor, 'knowledge.export');
    const job = await this.db.knowledgeExportJob.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, requesterId: actor.userId } }); if (!job) throw notFound('Export');
    if (job.expiresAt <= new Date()) { await this.db.knowledgeExportJob.update({ where: { id: job.id }, data: { status: 'EXPIRED', outputSealed: null } }); throw new AppError('INVALID_STATE_TRANSITION', 'Export expired.', 409); }
    if (job.status !== 'READY' || !job.outputSealed) return { status: job.status };
    for (const articleId of job.articleIds as string[]) {
      try { await this.db.$transaction(tx => loadArticle(tx, actor, articleId, 'VIEW')); }
      catch { throw new AppError('PERMISSION_DENIED', 'Access to exported content changed; request a new export.', 403); }
    }
    return { status: 'READY', format: job.format, encoding: job.format === 'DOCX' ? 'base64' : 'utf8', content: decrypt(job.outputSealed) };
  }
  async templates(actor: Principal, raw: unknown) {
    requirePermission(actor, 'knowledge.article.create');
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(raw);
    const where = { workspaceId: actor.workspaceId };
    const [rows, total] = await Promise.all([this.db.knowledgeTemplate.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.knowledgeTemplate.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  async createTemplate(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'knowledge.template.manage');
    const input = z.strictObject({ name: z.string().trim().min(1).max(160), content: z.unknown(), visibility: z.enum(['WORKSPACE', 'PRIVATE']).default('WORKSPACE') }).parse(raw);
    const { content } = normalizeContent(input.content, 200_000);
    return this.db.$transaction(async tx => {
      const row = await tx.knowledgeTemplate.create({ data: { workspaceId: actor.workspaceId, name: input.name, contentSchema: content, visibility: input.visibility, createdBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'KNOWLEDGE_TEMPLATE_CREATED', resourceType: 'KnowledgeTemplate', resourceId: row.id, after: { name: input.name }, requestId });
      return row;
    });
  }
}
