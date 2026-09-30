const { spawn, spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const port = Number(process.env.LIVE_ENDPOINT_PORT || 3101);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
}

function testDatabaseUrl() {
  const source = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
  const url = new URL(source);
  url.pathname = '/entertabcrm_test';
  return url.toString();
}

async function prepareDatabase(url) {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to recreate non-test database ${dbName}.`);

  const retryableCodes = new Set(['P1001', 'P1002', 'P1017']);
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
    try {
      await admin.$connect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      break;
    } catch (error) {
      const retryable = error && typeof error === 'object' && retryableCodes.has(error.code);
      if (!retryable || attempt === attempts) throw error;
      const delay = Math.min(250 * (2 ** (attempt - 1)), 2_000);
      console.warn(`Test database connection was not ready (attempt ${attempt}/${attempts}); retrying in ${delay}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      await admin.$disconnect();
    }
  }
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  run(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], env);
  run(process.execPath, ['Script/Seeding/SeedPermissions.js'], env);
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Next server did not become ready at ${baseUrl}.`);
}

async function main() {
  const databaseUrl = testDatabaseUrl();
  const fixtureRoot = path.join(root, '.local-postgres');
  const mailboxFile = path.join(fixtureRoot, `live-mailbox-${process.pid}.jsonl`);
  const googleProfilesFile = path.join(fixtureRoot, `live-google-${process.pid}.json`);
  const jobTokenFile = path.join(fixtureRoot, `live-job-token-${process.pid}.txt`);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(mailboxFile, '', 'utf8');
  fs.writeFileSync(googleProfilesFile, '{}', 'utf8');
  fs.writeFileSync(jobTokenFile, 'test-job-token-0123456789', 'utf8');
  const liveEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NEXT_DIST_DIR: '.next-live',
    INTERNAL_JOB_TOKEN: 'test-job-token-0123456789',
    TEST_MAILBOX_FILE: mailboxFile,
    TEST_GOOGLE_PROFILES_FILE: googleProfilesFile,
    TEST_INTERNAL_JOB_TOKEN_FILE: jobTokenFile,
  };
  let server = null;
  try {
    await prepareDatabase(databaseUrl);
    const nextBin = require.resolve('next/dist/bin/next');
    run(process.execPath, [nextBin, 'build'], liveEnv);

    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: root,
      env: { ...liveEnv, APP_URL: baseUrl },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForReady(baseUrl, server);
    run(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.config.ts', '--runInBand', 'tests/api-endpoints.spec.ts'], {
      ...liveEnv,
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      TEST_DATABASE_PREPARED: '1',
      API_TEST_BASE_URL: baseUrl,
    });
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    for (const fixture of [mailboxFile, googleProfilesFile, jobTokenFile]) {
      try { fs.rmSync(fixture, { force: true }); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
