import type { NextRequest } from 'next/server';
import { applyCursorQuery, parseCursorQuery } from '../query';

/** Cursor pagination for commercial-pack APIs with endpoint-specific field allowlists. */
export function paginateCommercial<T extends { id:string }>(
  request:NextRequest,
  rows:T[],
  config:{searchable:Array<keyof T & string>;filterable:Array<keyof T & string>;sortable:Array<keyof T & string>;defaultSortBy:keyof T & string},
){return applyCursorQuery(rows as Array<T&Record<string,unknown>>,parseCursorQuery<T&Record<string,unknown>>(request.nextUrl.searchParams),config);}
