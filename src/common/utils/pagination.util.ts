import { PaginationDto } from '../dto/pagination.dto';
import { PaginatedResult } from '../interfaces/paginated-result.interface';

export const buildWhereWithSoftDelete = (
  filters: Record<string, unknown> | undefined,
  softDeleteFilter: 'true' | 'false' | 'all' = 'false',
): Record<string, unknown> => {
  const where = { ...(filters ?? {}) };

  if (Object.prototype.hasOwnProperty.call(where, 'sortBy')) {
    delete where.sortBy;
  }

  if (softDeleteFilter === 'all') {
    return where;
  }

  if (!Object.prototype.hasOwnProperty.call(where, 'isDeleted')) {
    where.isDeleted = softDeleteFilter === 'true';
  }

  if (Object.prototype.hasOwnProperty.call(where, 'is_deleted')) {
    where.isDeleted = where.is_deleted;
    delete where.is_deleted;
  }

  if (!Object.prototype.hasOwnProperty.call(where, 'isDeleted')) {
    where.isDeleted = false;
  }

  return where;
};

export const buildPaginationParams = (
  paginationDto: PaginationDto,
  defaultSortBy = 'createdAt',
) => ({
  skip: (paginationDto.page - 1) * paginationDto.limit,
  take: paginationDto.limit,
  orderBy: {
    [typeof paginationDto.filters?.sortBy === 'string' ? paginationDto.filters.sortBy : defaultSortBy]:
      paginationDto.sortOrder,
  },
});

export const buildPaginatedResult = <T>(
  data: T[],
  total: number,
  paginationDto: PaginationDto,
): PaginatedResult<T> => ({
  data,
  meta: {
    total,
    page: paginationDto.page,
    limit: paginationDto.limit,
    totalPages: Math.ceil(total / paginationDto.limit) || 1,
  },
});
