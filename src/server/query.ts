import { badRequest } from './errors';
import type { PageMeta } from './domain';

export type QueryOptions<T> = {
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: keyof T & string;
  sortOrder?: 'asc' | 'desc';
  filters?: Record<string, { op: string; value: unknown }>;
};

type QueryConfig<T> = {
  searchable: (keyof T & string)[];
  filterable: (keyof T & string)[];
  sortable: (keyof T & string)[];
  defaultSortBy: keyof T & string;
};

export function parseQuery(searchParams: URLSearchParams): QueryOptions<never> {
  const page = Math.max(Number(searchParams.get('page') ?? '1'), 1);
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? '20'), 1), 100);
  const sortOrder = searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc';
  return {
    search: searchParams.get('search') ?? undefined,
    page,
    limit,
    sortBy: searchParams.get('sortBy') ?? undefined,
    sortOrder,
  };
}

export function applyQuery<T extends Record<string, unknown>>(
  rows: T[],
  options: QueryOptions<T>,
  config: QueryConfig<T>,
) {
  const page = options.page ?? 1;
  const limit = Math.min(options.limit ?? 20, 100);
  const sortBy = config.sortable.includes(options.sortBy ?? '') ? options.sortBy! : config.defaultSortBy;
  const sortOrder = options.sortOrder ?? 'asc';
  const search = options.search?.trim().toLowerCase();

  let filtered = rows;
  if (search) {
    filtered = filtered.filter((row) =>
      config.searchable.some((field) => String(row[field] ?? '').toLowerCase().includes(search)),
    );
  }

  filtered = [...filtered].sort((a, b) => {
    const left = String(a[sortBy] ?? '');
    const right = String(b[sortBy] ?? '');
    const result = left.localeCompare(right);
    return sortOrder === 'asc' ? result : -result;
  });

  const total = filtered.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const data = filtered.slice(start, start + limit);
  const meta: PageMeta = { page, limit, total, totalPages };
  return { data, meta };
}

export type CursorMeta = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type CursorQueryOptions<T> = {
  search?: string;
  limit?: number;
  cursor?: string;
  sortBy?: keyof T & string;
  sortOrder?: 'asc' | 'desc';
  filters?: Record<string, { op: 'eq' | 'contains' | 'startsWith' | 'endsWith' | 'isNull'; value?: unknown }>;
};

type CursorQueryConfig<T> = {
  searchable: (keyof T & string)[];
  filterable: (keyof T & string)[];
  sortable: (keyof T & string)[];
  defaultSortBy: keyof T & string;
};

type CursorState = {
  sortValue: string;
  id: string;
};

export function parseCursorQuery<T>(searchParams: URLSearchParams): CursorQueryOptions<T> {
  const rawFilters = searchParams.get('filters');
  let filters: CursorQueryOptions<T>['filters'];
  if (rawFilters) {
    try {
      filters = JSON.parse(rawFilters);
    } catch {
      throw badRequest('CRM_QUERY_INVALID', 'filters must be valid JSON.');
    }
  }
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? '20'), 1), 100);
  return {
    search: searchParams.get('search') ?? undefined,
    limit,
    cursor: searchParams.get('cursor') ?? undefined,
    sortBy: (searchParams.get('sortBy') ?? undefined) as CursorQueryOptions<T>['sortBy'],
    sortOrder: searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc',
    filters,
  };
}

export function applyCursorQuery<T extends { id: string } & Record<string, unknown>>(
  rows: T[],
  options: CursorQueryOptions<T>,
  config: CursorQueryConfig<T>,
): { data: T[]; meta: CursorMeta } {
  const sortBy = options.sortBy ?? config.defaultSortBy;
  if (!config.sortable.includes(sortBy)) throw badRequest('CRM_QUERY_FIELD_NOT_ALLOWED', 'sortBy is not allowed for this CRM endpoint.');
  const sortOrder = options.sortOrder ?? 'asc';
  const limit = Math.min(options.limit ?? 20, 100);
  const search = options.search?.trim().toLowerCase();

  let filtered = rows;
  if (search) {
    filtered = filtered.filter((row) =>
      config.searchable.some((field) => String(row[field] ?? '').toLowerCase().includes(search)),
    );
  }

  if (options.filters) {
    for (const [field, condition] of Object.entries(options.filters)) {
      if (!config.filterable.includes(field)) throw badRequest('CRM_QUERY_FIELD_NOT_ALLOWED', 'Filter field is not allowed for this CRM endpoint.');
      filtered = filtered.filter((row) => filterMatches(row[field], condition));
    }
  }

  const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortBy, sortOrder));
  const cursor = decodeCursor(options.cursor);
  const afterCursor = cursor
    ? sorted.filter((row) => isAfterCursor(row, sortBy, sortOrder, cursor))
    : sorted;
  const data = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;
  const last = data.at(-1);
  return {
    data,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ sortValue: cursorValue(last[sortBy]), id: last.id }) : null,
    },
  };
}

function filterMatches(value: unknown, condition: NonNullable<CursorQueryOptions<Record<string, unknown>>['filters']>[string]) {
  const actual = String(value ?? '').toLowerCase();
  const expected = String(condition.value ?? '').toLowerCase();
  if (condition.op === 'eq') return value === condition.value;
  if (condition.op === 'contains') return actual.includes(expected);
  if (condition.op === 'startsWith') return actual.startsWith(expected);
  if (condition.op === 'endsWith') return actual.endsWith(expected);
  if (condition.op === 'isNull') return value == null;
  throw badRequest('CRM_QUERY_OPERATOR_NOT_ALLOWED', 'Filter operator is not allowed for this CRM endpoint.');
}

function compareRows<T extends { id: string } & Record<string, unknown>>(a: T, b: T, sortBy: keyof T & string, sortOrder: 'asc' | 'desc') {
  const primary = cursorValue(a[sortBy]).localeCompare(cursorValue(b[sortBy]));
  const tied = primary === 0 ? a.id.localeCompare(b.id) : primary;
  return sortOrder === 'asc' ? tied : -tied;
}

function isAfterCursor<T extends { id: string } & Record<string, unknown>>(row: T, sortBy: keyof T & string, sortOrder: 'asc' | 'desc', cursor: CursorState) {
  const rowState = { sortValue: cursorValue(row[sortBy]), id: row.id };
  const comparison = rowState.sortValue === cursor.sortValue
    ? rowState.id.localeCompare(cursor.id)
    : rowState.sortValue.localeCompare(cursor.sortValue);
  return sortOrder === 'asc' ? comparison > 0 : comparison < 0;
}

function cursorValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function encodeCursor(state: CursorState) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): CursorState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.sortValue === 'string' && typeof parsed.id === 'string') return parsed;
  } catch {
    // fall through
  }
  throw badRequest('CRM_CURSOR_INVALID', 'cursor is invalid.');
}
