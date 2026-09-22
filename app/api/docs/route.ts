import { NextResponse } from 'next/server';
import { openApiDocument } from '@/src/server/openapi';

export function GET() {
  return NextResponse.json(openApiDocument);
}
