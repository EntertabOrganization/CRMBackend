import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

export function ApiPaginationQuery() {
  return applyDecorators(
    ApiQuery({
      name: 'page',
      required: false,
      type: Number,
      example: 1,
      description: 'Page number',
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      type: Number,
      example: 10,
      description: 'Items per page',
    }),
    ApiQuery({
      name: 'sortOrder',
      required: false,
      enum: ['desc', 'asc'],
      example: 'desc',
      description: 'Sort direction (desc or asc)',
    }),
    ApiQuery({
      name: 'filters',
      required: false,
      type: String,
      example: '',
      description: 'JSON string filters',
    }),
    ApiQuery({
      name: 'is_deleted',
      required: false,
      enum: ['true', 'false', 'all'],
      example: 'false',
      description: 'Soft delete filter',
    }),
  );
}
