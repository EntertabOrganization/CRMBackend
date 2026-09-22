const { PrismaClient } = require('@prisma/client');
const { PERMISSIONS } = require('./seed-config');

function permissionMetadata(key) {
  const parts = key.split('.');
  const resource = parts[0];
  const action = parts.slice(1).join('.');

  return {
    key,
    name: key,
    description: `${key} permission`,
    module: resource,
    resource,
    action,
    isDeleted: false,
  };
}

async function seedPermissions(prisma = new PrismaClient()) {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      create: permissionMetadata(key),
      update: permissionMetadata(key),
    });
  }

  return prisma.permission.findMany({
    where: { key: { in: PERMISSIONS }, isDeleted: false },
    orderBy: { key: 'asc' },
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const permissions = await seedPermissions(prisma);
    console.log(`Seeded ${permissions.length} permissions.`);
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

module.exports = { seedPermissions };
