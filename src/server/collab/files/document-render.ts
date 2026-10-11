import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { AppError } from '../../errors';

/**
 * Document template language and output writers. Templates are data, never code: the only constructs are
 * `{{path}}` substitutions and `{{#if path}}…{{else}}…{{/if}}` sections. Substituted values are escaped and never
 * re-parsed, so a value containing template syntax or markup is rendered literally.
 */

export type TemplateNode = { t: 'text'; v: string } | { t: 'var'; path: string } | { t: 'if'; path: string; then: TemplateNode[]; else: TemplateNode[] };
export type TemplateValue = string | number | boolean | Date | null | undefined | TemplateValue[] | { [key: string]: TemplateValue };
export type RenderContext = { resolve(path: string): TemplateValue };

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_MIME = 'application/pdf';
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,3}$/;
const MAX_DEPTH = 10;

export const invalidTemplate = (message: string, details: Record<string, unknown> = {}) => new AppError('DOCUMENT_TEMPLATE_INVALID', message, 400, details);

/** Parses the template language; anything that is not a recognised tag is rejected rather than passed through. */
export function parseTemplate(source: string, allowSections = true): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: Array<{ node: Extract<TemplateNode, { t: 'if' }>; inElse: boolean }> = [];
  const target = () => { const top = stack.at(-1); return top ? (top.inElse ? top.node.else : top.node.then) : root; };
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{{', index);
    const close = source.indexOf('}}', index);
    if (close >= 0 && (open < 0 || close < open)) throw invalidTemplate('Unbalanced "}}" in template.', { offset: close });
    if (open < 0) { target().push({ t: 'text', v: source.slice(index) }); break; }
    if (open > index) target().push({ t: 'text', v: source.slice(index, open) });
    if (source[open + 2] === '{') throw invalidTemplate('Unescaped "{{{" output is not supported.', { offset: open });
    const end = source.indexOf('}}', open + 2);
    if (end < 0) throw invalidTemplate('Unclosed "{{" in template.', { offset: open });
    const tag = source.slice(open + 2, end).trim();
    if (tag.includes('{')) throw invalidTemplate('Nested "{{" in template tag.', { offset: open });
    if (tag.startsWith('#if ')) {
      if (!allowSections) throw invalidTemplate('Sections are not supported in this template type.', { tag });
      const path = tag.slice(4).trim();
      if (!PATH_RE.test(path)) throw invalidTemplate(`Invalid variable reference "${path}".`, { tag });
      if (stack.length >= MAX_DEPTH) throw invalidTemplate('Sections are nested too deeply.', { tag });
      const node = { t: 'if' as const, path, then: [] as TemplateNode[], else: [] as TemplateNode[] };
      target().push(node); stack.push({ node, inElse: false });
    } else if (tag === 'else') {
      const top = stack.at(-1);
      if (!top || top.inElse) throw invalidTemplate('"{{else}}" without an open section.', { offset: open });
      top.inElse = true;
    } else if (tag === '/if') {
      if (!stack.pop()) throw invalidTemplate('"{{/if}}" without an open section.', { offset: open });
    } else if (PATH_RE.test(tag)) target().push({ t: 'var', path: tag });
    else throw invalidTemplate(`Unsupported template tag "${tag.slice(0, 80)}".`, { offset: open });
    index = end + 2;
  }
  if (stack.length) throw invalidTemplate('Unclosed "{{#if}}" section.');
  return root;
}

export function variablesOf(nodes: TemplateNode[], into = new Set<string>()) {
  for (const node of nodes) {
    if (node.t === 'var') into.add(node.path);
    else if (node.t === 'if') { into.add(node.path); variablesOf(node.then, into); variablesOf(node.else, into); }
  }
  return into;
}

export function escapeMarkup(value: string) {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** XML 1.0 forbids most control characters; they are removed rather than producing an unreadable package. */
const stripControl = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

export function formatValue(value: TemplateValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  }
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const truthy = (value: TemplateValue) => Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== false && value !== '' && value !== 0;

export function renderNodes(nodes: TemplateNode[], context: RenderContext, escape: (value: string) => string): string {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text') out += node.v;
    else if (node.t === 'var') out += escape(stripControl(formatValue(context.resolve(node.path))));
    else out += renderNodes(truthy(context.resolve(node.path)) ? node.then : node.else, context, escape);
  }
  return out;
}

/** HTML templates are rendered to documents or previews, never executed; active content is refused at save time. */
export function assertInertHtml(html: string) {
  if (/<\s*(script|iframe|object|embed|frame|frameset|applet|link|meta|base|form)\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /(javascript|vbscript|data)\s*:/i.test(html))
    throw invalidTemplate('HTML templates may not contain scripts, embedded objects, event handlers or script URLs.');
}

// ---- HTML -> structured blocks -------------------------------------------------------------------------------------------

export type Block = { kind: 'heading' | 'paragraph' | 'item'; text: string; level: number };
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'hr', 'tbody', 'thead']);

export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…', bull: '•' } as Record<string, string>)[name.toLowerCase()] ?? whole;
  });
}

export function htmlToBlocks(html: string): Block[] {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  const blocks: Block[] = [];
  let buffer = '', kind: Block['kind'] = 'paragraph', level = 0, cells = 0;
  const flush = () => {
    const text = decodeEntities(buffer).replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ kind, text, level });
    buffer = ''; kind = 'paragraph'; level = 0; cells = 0;
  };
  for (const match of cleaned.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g)) {
    const [token, closing, rawTag] = match;
    if (!rawTag) { buffer += token; continue; }
    const tag = rawTag.toLowerCase();
    if (tag === 'br') { flush(); continue; }
    if (tag === 'td' || tag === 'th') { if (!closing && cells++ > 0) buffer += ' | '; continue; }
    if (!BLOCK_TAGS.has(tag)) { buffer += ' '; continue; }
    flush();
    if (!closing && /^h[1-6]$/.test(tag)) { kind = 'heading'; level = Number(tag[1]); }
    else if (!closing && tag === 'li') kind = 'item';
  }
  flush();
  return blocks;
}

// ---- PDF writer ----------------------------------------------------------------------------------------------------------

const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };

function pdfString(text: string) {
  let out = '(';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const byte = WIN_ANSI[ch] ?? (code >= 0x20 && code <= 0x7e || code >= 0xa0 && code <= 0xff ? code : code < 0x20 ? -1 : 0x3f);
    if (byte < 0) continue;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

function wrap(text: string, maxChars: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let rest = word;
    while (rest.length > maxChars) {
      if (line) { lines.push(line); line = ''; }
      lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= maxChars) line += ` ${rest}`;
    else { lines.push(line); line = rest; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Deterministic A4 PDF (no timestamps or random IDs), so identical inputs reproduce identical bytes. */
export function blocksToPdf(blocks: Block[], title: string): Buffer {
  const width = 595, height = 842, margin = 56, usable = width - margin * 2;
  const pages: string[][] = [[]];
  let y = height - margin;
  for (const block of blocks.length ? blocks : [{ kind: 'paragraph' as const, text: ' ', level: 0 }]) {
    const size = block.kind === 'heading' ? Math.max(12, 20 - block.level * 2) : 11;
    const font = block.kind === 'heading' ? 'F2' : 'F1', leading = size * 1.35;
    const text = block.kind === 'item' ? `• ${block.text}` : block.text;
    for (const line of wrap(text, Math.max(10, Math.floor(usable / (size * 0.56))))) {
      if (y - leading < margin) { pages.push([]); y = height - margin; }
      y -= leading;
      pages.at(-1)!.push(`BT /${font} ${size} Tf ${margin} ${y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
    }
    y -= size * 0.5;
  }
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${6 + index * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title ${pdfString(title)} /Producer (TrueCRM Documents) >>`;
  pages.forEach((lines, index) => {
    const stream = lines.join('\n');
    objects[6 + index * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + index * 2} 0 R >>`;
    objects[7 + index * 2] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ---- ZIP container (DOCX) -----------------------------------------------------------------------------------------------

export type ZipEntry = { name: string; data: Buffer };
const ZIP_LIMITS = { entries: 2000, totalBytes: 64 * 1024 * 1024 };

const invalidPackage = (message: string) => invalidTemplate(message);

/** Reads a non-encrypted, non-ZIP64 archive with bounded decompression (zip-bomb safe). */
export function readZip(buffer: Buffer): ZipEntry[] {
  const start = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= start; index--) if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0) throw invalidPackage('The DOCX source is not a valid ZIP package.');
  const count = buffer.readUInt16LE(eocd + 10), cdSize = buffer.readUInt32LE(eocd + 12), cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || count > ZIP_LIMITS.entries || cdOffset + cdSize > eocd) throw invalidPackage('The DOCX package layout is unsupported.');
  const entries: ZipEntry[] = [], names = new Set<string>();
  let pointer = cdOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) throw invalidPackage('The DOCX central directory is corrupt.');
    const flags = buffer.readUInt16LE(pointer + 8), method = buffer.readUInt16LE(pointer + 10), crc = buffer.readUInt32LE(pointer + 16);
    const compressed = buffer.readUInt32LE(pointer + 20), size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28), extra = buffer.readUInt16LE(pointer + 30), comment = buffer.readUInt16LE(pointer + 32);
    const local = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extra + comment;
    if (flags & 0x1) throw invalidPackage('Encrypted DOCX packages are not supported.');
    if (method !== 0 && method !== 8) throw invalidPackage('The DOCX package uses an unsupported compression method.');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw invalidPackage('The DOCX package contains an unsafe entry name.');
    total += size;
    if (size > ZIP_LIMITS.totalBytes || total > ZIP_LIMITS.totalBytes) throw invalidPackage('The DOCX package expands beyond the supported size.');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw invalidPackage('The DOCX local header is corrupt.');
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > buffer.length) throw invalidPackage('The DOCX package is truncated.');
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); }
    catch { throw invalidPackage('The DOCX package could not be decompressed.'); }
    if (data.length !== size || crc32(data) >>> 0 !== crc) throw invalidPackage('The DOCX package failed integrity verification.');
    names.add(name); if (!name.endsWith('/')) entries.push({ name, data });
  }
  return entries;
}

/** Deterministic archive: fixed 1980-01-01 timestamps, stable entry order, UTF-8 names. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = deflateRawSync(entry.data, { level: 6 }), crc = crc32(entry.data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(0x0021, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x0021, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, name, data); centrals.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- DOCX ----------------------------------------------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TEXT_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const TEXT_NODE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

export function blocksToDocx(blocks: Block[]): Buffer {
  const xml = (text: string) => escapeMarkup(stripControl(text));
  const paragraphs = blocks.map(block => {
    const props = block.kind === 'heading' ? `<w:rPr><w:b/><w:sz w:val="${Math.max(24, 40 - block.level * 4)}"/></w:rPr>` : '';
    const text = block.kind === 'item' ? `• ${block.text}` : block.text;
    return `<w:p><w:r>${props}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  }).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W_NS}"><w:body>${paragraphs || '<w:p/>'}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/**
 * Validates a DOCX template and returns the variables it references. Placeholders must sit inside one text run;
 * Word may split typed text across runs, and a split placeholder is rejected instead of being silently left in output.
 */
export function inspectDocx(buffer: Buffer) {
  const entries = readZip(buffer);
  if (!entries.some(entry => entry.name === 'word/document.xml')) throw invalidTemplate('The DOCX package has no word/document.xml part.');
  const variables = new Set<string>();
  for (const entry of entries.filter(entry => TEXT_PART.test(entry.name))) {
    let joined = '';
    for (const match of entry.data.toString('utf8').matchAll(TEXT_NODE)) {
      const text = match[2];
      for (const placeholder of text.matchAll(PLACEHOLDER))
        for (const node of parseTemplate(placeholder[0], false)) if (node.t === 'var') variables.add(node.path);
      joined += text.replace(PLACEHOLDER, '');
    }
    if (joined.includes('{{') || joined.includes('}}')) throw invalidTemplate('A DOCX placeholder is split across formatting runs; retype it without mid-word formatting.', { part: entry.name });
  }
  return { entries, variables };
}

export function renderDocx(entries: ZipEntry[], context: RenderContext): Buffer {
  return writeZip(renderDocxEntries(entries, context));
}

export function renderDocxEntries(entries: ZipEntry[], context: RenderContext): ZipEntry[] {
  return entries.map(entry => TEXT_PART.test(entry.name) ? { name: entry.name, data: Buffer.from(entry.data.toString('utf8').replace(TEXT_NODE, (whole, attrs: string | undefined, text: string) => {
    if (!text.includes('{{')) return whole;
    const rendered = text.replace(PLACEHOLDER, placeholder => renderNodes(parseTemplate(placeholder, false), context, value => escapeMarkup(value)));
    return `<w:t${attrs?.includes('xml:space') ? attrs : `${attrs ?? ''} xml:space="preserve"`}>${rendered}</w:t>`;
  }), 'utf8') } : entry);
}

/** Plain-text paragraphs of the main document part, used for previews. */
export function docxText(entries: ZipEntry[]) {
  const document = entries.find(entry => entry.name === 'word/document.xml')!.data.toString('utf8');
  return [...document.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(paragraph => decodeEntities([...paragraph[0].matchAll(TEXT_NODE)].map(match => match[2]).join('')))
    .filter(Boolean).join('\n');
}
