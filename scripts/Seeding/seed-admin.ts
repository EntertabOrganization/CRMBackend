import { Prisma, PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  console.log('Seeding admin user and Cultiv company...');

  // 1. Ensure all permissions exist first
  const permissions = await prisma.permission.findMany({
    where: { isDeleted: false },
    select: { id: true, slug: true },
  });

  if (permissions.length === 0) {
    console.error('No permissions found. Run seed-permissions.ts first.');
    process.exit(1);
  }

  console.log(`Found ${permissions.length} permissions.`);

  const adminEmail = 'admin@Cultiv.com';

  // 2. Ensure company, role, user exist; then always sync admin permissions
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Ensure the Cultiv company exists
    let company = await tx.company.findFirst({
      where: { name: 'Cultiv' },
    });

    if (!company) {
      company = await tx.company.create({
        data: {
          name: 'Cultiv',
          email: 'info@cultiv.com',
          phoneNumber: '+201000000000',
          description: 'Cultiv Bureau - Digital Transformation & Software Solutions',
          location: 'Cairo, Egypt',
          address: '5th Settlement, New Cairo, Egypt',
          companyCategory: 'Software Development',
          isDeleted: false,
        },
      });
      console.log(`Created company: ${company.name} (${company.id})`);
    } else {
      console.log(`Using existing company: ${company.name} (${company.id})`);
    }

    // Ensure the admin role exists
    let adminRole = await tx.role.findFirst({
      where: { companyId: company.id, name: 'admin' },
    });

    if (!adminRole) {
      adminRole = await tx.role.create({
        data: {
          name: 'admin',
          description: 'Super administrator role with all permissions for Cultiv.',
          companyId: company.id,
          isDeleted: false,
        },
      });
      console.log(`Created admin role: ${adminRole.name} (${adminRole.id})`);
    } else {
      await tx.role.update({
        where: { id: adminRole.id },
        data: {
          description: 'Super administrator role with all permissions for Cultiv.',
          isDeleted: false,
        },
      });
      console.log(`Using existing admin role: ${adminRole.name} (${adminRole.id})`);
    }

    // Sync admin role permissions to all active permissions
    const existingRolePermissions = await tx.rolePermission.findMany({
      where: {
        roleId: adminRole.id,
      },
      select: {
        permissionId: true,
      },
    });
    const existingPermissionIds = new Set(existingRolePermissions.map((rp) => rp.permissionId));
    const validPermissionIds = new Set(permissions.map((p: any) => p.id));
    const missingPermissionIds = permissions
      .map((p: { id: string }) => p.id)
      .filter((permissionId) => !existingPermissionIds.has(permissionId));

    if (missingPermissionIds.length > 0) {
      await tx.rolePermission.createMany({
        data: missingPermissionIds.map((permissionId) => ({
          roleId: adminRole.id,
          permissionId,
          isDeleted: false,
        })),
        skipDuplicates: true,
      });
      console.log(`Added ${missingPermissionIds.length} missing permission(s) to admin role.`);
    } else {
      console.log('Admin role already has all active permissions.');
    }

    // Ensure admin user exists
    let adminUser = await tx.user.findUnique({
      where: { email: adminEmail },
    });

    if (!adminUser) {
      adminUser = await tx.user.create({
        data: {
          firstName: 'Admin',
          lastName: 'Cultiv',
          email: adminEmail,
          password: hashPassword('Admin@1234'),
          phoneNumber: '+201000000001',
          companyId: company.id,
          isDeleted: false,
        },
      });
      console.log(`Created admin user: ${adminUser.email} (${adminUser.id})`);
    } else {
      adminUser = await tx.user.update({
        where: { id: adminUser.id },
        data: {
          companyId: company.id,
          isDeleted: false,
        },
      });
      console.log(`Using existing admin user: ${adminUser.email} (${adminUser.id})`);
    }

    // Ensure user-role link exists and is active
    const existingUserRole = await tx.userRole.findUnique({
      where: {
        userId_roleId: {
          userId: adminUser.id,
          roleId: adminRole.id,
        },
      },
    });

    if (!existingUserRole) {
      await tx.userRole.create({
        data: {
          userId: adminUser.id,
          roleId: adminRole.id,
          isDeleted: false,
        },
      });
      console.log('Assigned admin role to admin user.');
    } else if (existingUserRole.isDeleted) {
      await tx.userRole.update({
        where: {
          userId_roleId: {
            userId: adminUser.id,
            roleId: adminRole.id,
          },
        },
        data: { isDeleted: false },
      });
      console.log('Reactivated admin role assignment for admin user.');
    }

    // Set the admin user as the company owner
    await tx.company.update({
      where: { id: company.id },
      data: { ownerId: adminUser.id },
    });

    console.log(`Set ${adminUser.email} as owner of ${company.name}`);
  });

  console.log('Admin seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
