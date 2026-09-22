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
