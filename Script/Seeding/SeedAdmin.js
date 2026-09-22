const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_FIRST_NAME,
  ADMIN_LAST_NAME,
  ADMIN_WORKSPACE_NAME,
  ADMIN_WORKSPACE_SLUG,
  ADMIN_ROLE_NAME,
} = require('./seed-config');

async function seedAdmin(prisma = new PrismaClient()) {
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const email = ADMIN_EMAIL.trim().toLowerCase();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email },
      create: {
        firstName: ADMIN_FIRST_NAME,
        lastName: ADMIN_LAST_NAME,
        email,
        settings: {},
        meta: { seeded: true, seedName: 'SeedAdmin' },
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        isDeleted: false,
      },
      update: {
        firstName: ADMIN_FIRST_NAME,
        lastName: ADMIN_LAST_NAME,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        isDeleted: false,
      },
    });

    await tx.authIdentity.upsert({
      where: {
        userId_provider: {
          userId: user.id,
          provider: 'LOCAL',
        },
      },
      create: {
        userId: user.id,
        provider: 'LOCAL',
        passwordHash,
        isDeleted: false,
      },
      update: {
        passwordHash,
        isDeleted: false,
      },
    });

    const workspace = await tx.workspace.upsert({
      where: { slug: ADMIN_WORKSPACE_SLUG },
      create: {
        name: ADMIN_WORKSPACE_NAME,
        slug: ADMIN_WORKSPACE_SLUG,
        settings: {},
        meta: { seeded: true, seedName: 'SeedAdmin' },
        ownerUserId: user.id,
        isDeleted: false,
      },
      update: {
        name: ADMIN_WORKSPACE_NAME,
        ownerUserId: user.id,
        isDeleted: false,
      },
    });

    const role = await tx.role.findFirst({
      where: {
        workspaceId: workspace.id,
        name: ADMIN_ROLE_NAME,
      },
    });

    const adminRole = role
      ? await tx.role.update({
          where: { id: role.id },
          data: {
            description: 'Seeded protected admin role',
            isSystem: true,
            isOwnerRole: true,
            isDeleted: false,
          },
        })
      : await tx.role.create({
          data: {
            workspaceId: workspace.id,
            name: ADMIN_ROLE_NAME,
            description: 'Seeded protected admin role',
            isSystem: true,
            isOwnerRole: true,
            isDeleted: false,
          },
        });

    await tx.workspaceMembership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: workspace.id,
          userId: user.id,
        },
      },
      create: {
        workspaceId: workspace.id,
        userId: user.id,
        roleId: adminRole.id,
        status: 'ACTIVE',
        isDeleted: false,
      },
      update: {
        roleId: adminRole.id,
        status: 'ACTIVE',
        isDeleted: false,
      },
    });

    await tx.user.update({
      where: { id: user.id },
      data: {
        settings: {
          lastActiveWorkspaceId: workspace.id,
        },
      },
    });

    return { user, workspace, role: adminRole };
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await seedAdmin(prisma);
    console.log(`Seeded admin user ${result.user.email} with workspace ${result.workspace.slug}.`);
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

module.exports = { seedAdmin };
