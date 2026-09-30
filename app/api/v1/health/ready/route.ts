import { NextResponse } from 'next/server';
import { prisma } from '@/src/server/prisma-client';

export const runtime = 'nodejs';

type MigrationRow = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const migrations = await prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `;
    const failed = migrations.filter((row) => !row.finished_at && !row.rolled_back_at);
    if (migrations.length === 0 || failed.length > 0) {
      return NextResponse.json(
        { success: false, error: { code: 'DATABASE_MIGRATIONS_NOT_READY', message: 'Database migrations are not ready.' } },
        { status: 503 },
      );
    }
    return NextResponse.json({
      success: true,
      data: { status: 'ready', database: 'available', appliedMigrations: migrations.filter((row) => row.finished_at).length },
      meta: null,
    });
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable.' } },
      { status: 503 },
    );
  }
}
