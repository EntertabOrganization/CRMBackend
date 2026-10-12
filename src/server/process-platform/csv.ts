import { AppError } from '../errors';

/** Bounded RFC-style CSV parser: quoted delimiters/newlines and escaped quotes, without expression evaluation. */
export function parseCsv(bytes: Buffer, maxRows = 10000): Record<string, string>[] {
  if (bytes.length > 10_000_000) throw new AppError('SPA_IMPORT_ROW_INVALID', 'Import File exceeds the size limit.', 422);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new AppError('SPA_IMPORT_ROW_INVALID', 'CSV must use UTF-8.', 422); }
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { if (row.length >= 500) throw invalid(); row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; if (rows.length > maxRows + 1) throw invalid(); };
  const invalid = () => new AppError('SPA_IMPORT_ROW_INVALID', 'CSV structure or processing limits are invalid.', 422);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"') { if (cell || closed) throw invalid(); quoted = true; }
    else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else { if (closed) throw invalid(); cell += char; }
    if (cell.length > 100000) throw invalid();
  }
  if (quoted) throw invalid();
  if (cell || row.length || closed) finishRow();
  const headers = rows.shift();
  if (!headers?.length || headers.some(h => !h.trim() || h.length > 160) || new Set(headers).size !== headers.length) throw invalid();
  return rows.map(values => { if (values.length !== headers.length) throw invalid(); return Object.fromEntries(headers.map((h, i) => [h, values[i]])); });
}

/** Escaping also neutralizes spreadsheet formulas in untrusted textual cells. */
export function encodeCsv(headers: string[], rows: unknown[][]) {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return Buffer.from('\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n'), 'utf8');
}
