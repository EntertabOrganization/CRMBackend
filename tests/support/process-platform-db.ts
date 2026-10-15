import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** The Process Pack's focused suites own these disposable databases only. */
export async function prepareProcessPlatformDatabase(name: string) {
  const trace = (stage: string) => { if (process.env.PROCESS_PACK_TEST_TRACE==='1') process.stderr.write(`[${name}] ${stage}\n`); };
  const url = new URL(process.env.PROCESS_PACK_TEST_DATABASE_URL ?? 'postgresql://entertabcrm:entertabcrm@127.0.0.1:5432/postgres?schema=public');
  // Only local databases following the owned disposable naming rule may be dropped and recreated.
  if (!['localhost','127.0.0.1'].includes(url.hostname) || !/^truecrm_[a-z0-9_]+_test$/.test(name)) throw new Error('A local, explicitly owned Process Pack test database is required.');
  url.hostname = '127.0.0.1'; url.pathname = '/'+name;
  url.searchParams.set('connect_timeout','30'); url.searchParams.set('pool_timeout','30');
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    trace('recreating owned database');
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally { await admin.$disconnect(); }
  const root = path.resolve(__dirname,'../..');
  trace('deploying migrations');
  execFileSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy'],{ cwd: root,env: { ...process.env,DATABASE_URL: url.toString() },stdio: 'pipe' });
  process.env.DATABASE_URL = url.toString();
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const { PERMISSIONS } = require('../../Script/Seeding/seed-config') as { PERMISSIONS: string[] };
  try {
    trace('seeding permission catalog in one batch');
    // Preserve the repository's catalog. One INSERT avoids hundreds of individual WAL commits.
    await db.permission.createMany({ data: [...new Set(PERMISSIONS)].map(key => ({ key,name: key,description: key+' permission',module: key.split('.')[0],resource: key.split('.')[0],action: key.split('.').slice(1).join('.'),isDeleted: false })) });
  } finally { await db.$disconnect(); }
  trace('database ready');
  return url.toString();
}
