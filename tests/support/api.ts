import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

export const TEST_DB_NAME = 'entertabcrm_test';
const DEFAULT_TEST_URL = `postgresql://entertabcrm:entertabcrm@localhost:5432/${TEST_DB_NAME}?schema=public`;
const ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

export type ApiOptions = {
  token?: string;
  workspaceId?: string;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  /** For streaming endpoints (SSE): return once headers arrive and cancel the body instead of waiting for it to end. */
  stream?: boolean;
};

export type ApiResult<T = any> = {
  status: number;
  body: any;
  data: T;
};

const covered = new Set<string>();
/** Endpoints exercised with real credentials (a bearer token or the internal job token), not just rejected. */
const coveredAuthenticated = new Set<string>();
let requestCounter = 0;

/**
 * Points Prisma at a throwaway database, migrates it and seeds the permission catalog.
 * Must run before anything imports `src/server/prisma-client`.
 */
export async function prepareTestDatabase() {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run endpoint tests against "${dbName}". The database name must end with _test.`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: url };
  execSync('npx prisma migrate deploy', { cwd: ROOT, env, stdio: 'pipe' });
  execSync('node Script/Seeding/SeedPermissions.js', { cwd: ROOT, env, stdio: 'pipe' });
  process.env.DATABASE_URL = url;
}

export async function disconnectTestDatabase() {
  const { prisma } = await import('@/src/server/prisma-client');
  await prisma.$disconnect();
}

export function coveredAuthenticatedEndpoints() {
  return new Set(coveredAuthenticated);
}

export function coveredEndpoints() {
  return new Set(covered);
}

export async function api<T = any>(method: Method, template: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const routeModule = await import(`@/app${template === '/' ? '' : template}/route`);
  const handler = routeModule[method];
  if (typeof handler !== 'function') throw new Error(`${method} ${template} is not exported by its route file.`);

  const params = options.params ?? {};
  const resolvedPath = template.replace(/\[(\w+)\]/g, (_, key: string) => {
    if (!params[key]) throw new Error(`Missing path param "${key}" for ${template}`);
    return params[key];
  });
  const url = new URL(`http://localhost${resolvedPath}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // A unique client address keeps the in-memory auth rate limiter out of the way.
    'x-forwarded-for': `10.0.${Math.floor(requestCounter / 250)}.${(requestCounter++ % 250) + 1}`,
    ...options.headers,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceId) headers['x-workspace-id'] = options.workspaceId;

  const request = new NextRequest(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response: Response = await handler(request, { params: Promise.resolve(params) });
  covered.add(`${method} ${template}`);
  if (options.token || options.headers?.['x-internal-job-token']) coveredAuthenticated.add(`${method} ${template}`);

  if (options.stream && response.status === 200) {
    await response.body?.cancel();
    return { status: response.status, body: null, data: undefined as never };
  }
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON responses (the landing page and swagger UI) are returned as text.
  }
  return { status: response.status, body, data: body?.data };
}

/** Lists every `METHOD /template` the app/ directory exposes, by importing each route module. */
export async function discoverEndpoints() {
  const endpoints: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === 'route.ts') {
        const template = '/' + path.relative(APP_DIR, dir).split(path.sep).join('/');
        const routeModule = await import(`@/app${template === '/.' || template === '/' ? '' : template}/route`);
        for (const method of METHODS) {
          if (typeof routeModule[method] === 'function') endpoints.push(`${method} ${template === '/.' ? '/' : template}`);
        }
      }
    }
  };
  await walk(APP_DIR);
  return endpoints.sort();
}
