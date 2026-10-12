import { Prisma } from '@prisma/client';
import { AppError } from '../errors';
import { canonical } from '../process-platform/dto';

export type Expression = { kind: 'literal'; value: string | boolean | null } |
  { kind: 'number'; value: string } | { kind: 'reference'; path: string[] } |
  { kind: 'unary'; operator: string; operand: Expression } |
  { kind: 'binary'; operator: string; left: Expression; right: Expression } |
  { kind: 'call'; name: string; arguments: Expression[] };
type Token = { kind: string; text: string };
const forbidden = new Set(['__proto__','prototype','constructor']);
const roots = new Set(['parameters','variables','constants','entity','outputs','actor','now','iteration']);
const functions = new Set(['date','addDays','addSeconds','length','contains','coalesce']);
const precedence: Record<string, number> = { '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '>': 5, '>=': 5, '<': 5, '<=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };
const invalid = () => new AppError('WORKFLOW_UNSAFE_EXPRESSION', 'Expression is invalid or exceeds safe limits.', 422);

/** Bounded grammar, no dynamic evaluation, property reflection or user-defined calls. */
export function compileExpression(source: string): Expression {
  if (typeof source !== 'string' || source.length > 4000 || !source.trim()) throw invalid();
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) { offset++; continue; }
    const rest = source.slice(offset);
    const numeric = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?/.exec(rest);
    const identifier = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0]; let end = 1, value = '';
      while (end < rest.length && rest[end] !== quote) {
        if (rest[end] === '\\') {
          end++; const escaped = rest[end];
          if (!['\\','"',"'",'n','r','t'].includes(escaped)) throw invalid();
          value += ({ n: '\n', r: '\r', t: '\t' } as Record<string,string>)[escaped] ?? escaped;
        } else { if (rest.charCodeAt(end) < 32) throw invalid(); value += rest[end]; }
        end++;
      }
      if (end === rest.length) throw invalid();
      tokens.push({ kind: 'string', text: value }); offset += end + 1;
    } else if (numeric) { tokens.push({ kind: 'number', text: numeric[0] }); offset += numeric[0].length; }
    else if (identifier) { tokens.push({ kind: 'identifier', text: identifier[0] }); offset += identifier[0].length; }
    else {
      const operator = /^(?:\?\?|\|\||&&|==|!=|>=|<=|[+\-*/%><!().,])/.exec(rest);
      if (!operator) throw invalid();
      tokens.push({ kind: 'operator', text: operator[0] }); offset += operator[0].length;
    }
    if (tokens.length > 500) throw invalid();
  }
  let cursor = 0, count = 0;
  const consume = (expected: string) => { if (tokens[cursor++]?.text !== expected) throw invalid(); };
  const expression = (minimum = 0, depth = 0): Expression => {
    if (++count > 200 || depth > 32) throw invalid();
    const token = tokens[cursor++]; if (!token) throw invalid();
    let left: Expression;
    if (token.kind === 'number') { if (token.text.length > 29) throw invalid(); left = { kind: 'number', value: token.text }; }
    else if (token.kind === 'string') left = { kind: 'literal', value: token.text };
    else if (token.text === '(') { left = expression(0, depth + 1); consume(')'); }
    else if (['!','-','+'].includes(token.text)) left = { kind: 'unary', operator: token.text, operand: expression(8, depth + 1) };
    else if (token.kind === 'identifier') {
      if (['true','false','null'].includes(token.text)) left = { kind: 'literal', value: token.text === 'null' ? null : token.text === 'true' };
      else if (tokens[cursor]?.text === '(') {
        if (!functions.has(token.text)) throw invalid();
        cursor++; const arguments_: Expression[] = [];
        if (tokens[cursor]?.text !== ')') do {
          if (arguments_.length >= 3) throw invalid();
          arguments_.push(expression(0, depth + 1));
          if (tokens[cursor]?.text !== ',') break;
          cursor++;
        } while (true);
        consume(')'); left = { kind: 'call', name: token.text, arguments: arguments_ };
      } else {
        if (!roots.has(token.text)) throw invalid();
        const path = [token.text];
        while (tokens[cursor]?.text === '.') {
          cursor++; const next = tokens[cursor++];
          if (!next || next.kind !== 'identifier' || forbidden.has(next.text) || path.length > 8) throw invalid();
          path.push(next.text);
        }
        left = { kind: 'reference', path };
      }
    } else throw invalid();
    while (tokens[cursor] && (precedence[tokens[cursor].text] ?? -1) >= minimum) {
      const operator = tokens[cursor++].text;
      left = { kind: 'binary', operator, left, right: expression(precedence[operator] + 1, depth + 1) };
    }
    return left;
  };
  const result = expression(); if (cursor !== tokens.length) throw invalid(); return result;
}

const number = (value: unknown) => {
  if (!(typeof value === 'string' || typeof value === 'number' || Prisma.Decimal.isDecimal(value))) throw invalid();
  try { const parsed = new Prisma.Decimal(value as string); if (!parsed.isFinite() || parsed.abs().gte('1e20')) throw invalid(); return parsed; }
  catch { throw invalid(); }
};
const boolean = (value: unknown) => { if (typeof value !== 'boolean') throw invalid(); return value; };
const date = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(value)) throw invalid();
  const result = new Date(value); if (!Number.isFinite(result.getTime())) throw invalid(); return result;
};

export function evaluateExpression(expression: Expression, context: Record<string, unknown>): unknown {
  let budget = 500;
  const run = (node: Expression, depth = 0): unknown => {
    if (--budget < 0 || depth > 32) throw invalid();
    switch (node.kind) {
      case 'literal': return node.value;
      case 'number': return number(node.value).toString();
      case 'reference': {
        let value: unknown = context;
        for (const key of node.path) {
          if (forbidden.has(key) || !value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) return null;
          value = (value as Record<string,unknown>)[key];
        }
        return value;
      }
      case 'unary': {
        const value = run(node.operand, depth + 1);
        return node.operator === '!' ? !boolean(value) : node.operator === '-' ? number(value).negated().toString() : number(value).toString();
      }
      case 'binary': {
        const left = run(node.left, depth + 1);
        if (node.operator === '&&') return boolean(left) && boolean(run(node.right, depth + 1));
        if (node.operator === '||') return boolean(left) || boolean(run(node.right, depth + 1));
        if (node.operator === '??') return left ?? run(node.right, depth + 1);
        const right = run(node.right, depth + 1);
        if (node.operator === '==') return canonical(left) === canonical(right);
        if (node.operator === '!=') return canonical(left) !== canonical(right);
        if (['>','>=','<','<='].includes(node.operator)) {
          const comparison = number(left).comparedTo(number(right));
          return node.operator === '>' ? comparison > 0 : node.operator === '>=' ? comparison >= 0 : node.operator === '<' ? comparison < 0 : comparison <= 0;
        }
        const a = number(left), b = number(right);
        if (['/','%'].includes(node.operator) && b.isZero()) throw invalid();
        const result = node.operator === '+' ? a.add(b) : node.operator === '-' ? a.sub(b) : node.operator === '*' ? a.mul(b)
          : node.operator === '/' ? a.div(b) : a.mod(b);
        return number(result.toDecimalPlaces(8)).toString();
      }
      case 'call': {
        const values = node.arguments.map(argument => run(argument, depth + 1));
        if (node.name === 'date' && values.length === 1) return date(values[0]).toISOString();
        if (['addDays','addSeconds'].includes(node.name) && values.length === 2) {
          const amount = number(values[1]);
          if (!amount.isInteger() || amount.abs().gt(1000000)) throw invalid();
          const result = new Date(date(values[0]).getTime() + amount.toNumber() * (node.name === 'addDays' ? 86400000 : 1000));
          if (!Number.isFinite(result.getTime())) throw invalid(); return result.toISOString();
        }
        if (node.name === 'length' && values.length === 1 && (typeof values[0] === 'string' || Array.isArray(values[0]))) return String(values[0].length);
        if (node.name === 'contains' && values.length === 2 && typeof values[0] === 'string' && typeof values[1] === 'string') return values[0].includes(values[1]);
        if (node.name === 'coalesce' && values.length >= 1) return values.find(value => value !== null && value !== undefined) ?? null;
        throw invalid();
      }
      default: throw invalid();
    }
  };
  return run(expression);
}
