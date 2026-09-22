const { PrismaClient } = require('@prisma/client');
const { ADMIN_ROLE_NAME, ADMIN_WORKSPACE_SLUG, PERMISSIONS } = require('./seed-config');
const { seedAdmin } = require('./SeedAdmin');
const { seedPermissions } = require('./SeedPermissions');

async function seedAdminPermissions(prisma = new PrismaClient()) {
  await seedPermissions(prisma);
  const { role } = await seedAdmin(prisma);

  const permissions = await prisma.permission.findMany({
    where: {
      key: { in: PERMISSIONS },
      isDeleted: false,
    },
  });

  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: role.id,
          permissionId: permission.id,
        },
      },
      create: {
        roleId: role.id,
        permissionId: permission.id,
        scope: 'WORKSPACE',
        isDeleted: false,
      },
      update: {
        scope: 'WORKSPACE',
        isDeleted: false,
      },
    });
  }

  return {
    role,
    permissionCount: permissions.length,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await seedAdminPermissions(prisma);
    console.log(
      `Seeded ${result.permissionCount} permissions for ${ADMIN_ROLE_NAME} in ${ADMIN_WORKSPACE_SLUG}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { seedAdminPermissions };
