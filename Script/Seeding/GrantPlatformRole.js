/**
 * Grants or revokes a platform role (separate from Workspace roles; never grants tenant data access).
 * Usage: node Script/Seeding/GrantPlatformRole.js <email> <PLATFORM_ADMIN|SUPPORT_AGENT|SRE|REVOKE> [--no-mfa]
 * `--no-mfa` is only for local development; production platform roles keep step-up MFA required.
 */
const { PrismaClient } = require('@prisma/client');
const catalog = require('../../src/server/platform/platform-permissions.json');

async function main() {
  const [email, role, flag] = process.argv.slice(2);
  if (!email || !role) throw new Error('Usage: GrantPlatformRole.js <email> <role|REVOKE> [--no-mfa]');
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false } });
    if (!user) throw new Error('User not found.');
    if (role === 'REVOKE') {
      await prisma.platformRoleAssignment.updateMany({ where: { userId: user.id }, data: { active: false, revokedAt: new Date() } });
      console.log('Platform role revoked.');
      return;
    }
    const permissions = catalog.bundles[role];
    if (!permissions) throw new Error(`Unknown role ${role}.`);
    const mfaRequired = flag !== '--no-mfa';
    await prisma.platformRoleAssignment.upsert({ where: { userId: user.id }, create: { userId: user.id, role, permissions, mfaRequired }, update: { role, permissions, mfaRequired, active: true, revokedAt: null } });
    console.log(`Granted ${role} (${permissions.length} permissions, mfaRequired=${mfaRequired}).`);
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exit(1); });
