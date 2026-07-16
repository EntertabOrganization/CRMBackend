import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SYSTEM_COMPANY_NAME = 'System Default';
const SYSTEM_COMPANY_CATEGORY = 'System';
const ROLE_NAME = 'RoleNotAssigned';
const COMPANY_MODULE_NAME = 'Company';

async function main() {
  const systemCompany =
    (await prisma.company.findFirst({
      where: {
        name: SYSTEM_COMPANY_NAME,
        companyCategory: SYSTEM_COMPANY_CATEGORY,
      },
      select: {
        id: true,
      },
    })) ??
    (await prisma.company.create({
      data: {
        name: SYSTEM_COMPANY_NAME,
        companyCategory: SYSTEM_COMPANY_CATEGORY,
        description: 'Hidden system company used for default platform roles.',
        isDeleted: false,
      },
      select: {
        id: true,
      },
    }));

  const role =
    (await prisma.role.findFirst({
      where: {
        name: ROLE_NAME,
        companyId: systemCompany.id,
      },
      select: {
        id: true,
      },
    })) ??
    (await prisma.role.create({
      data: {
        name: ROLE_NAME,
        description: 'Fallback role for users who have not joined a company yet.',
        companyId: systemCompany.id,
        isDeleted: false,
      },
      select: {
        id: true,
      },
    }));

  const permissions = await prisma.permission.findMany({
    where: {
      module: COMPANY_MODULE_NAME,
      isDeleted: false,
    },
    select: {
      id: true,
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
      update: {
        isDeleted: false,
      },
      create: {
        roleId: role.id,
        permissionId: permission.id,
        isDeleted: false,
      },
    });
  }

  console.log(`Role ${ROLE_NAME} is ready with ${permissions.length} company permissions.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
