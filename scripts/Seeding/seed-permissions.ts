import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// Updated MODULES to include all modules from app.module.ts
const MODULES = [
  'Company',
  'Users',
  'Roles',
  'Permissions'
];
const OPERATIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'SOFTDELETE', 'RESTORE'];

async function main() {
  console.log('Seeding permissions...');

  for (const moduleName of MODULES) {
    for (const operation of OPERATIONS) {
      const slug = `${moduleName.toLowerCase()}_${operation.toLowerCase()}`;
      const name = `${operation} ${moduleName}`;
      const description = `Allows ${operation.toLowerCase()} operations on ${moduleName}`;
      const id = crypto.randomUUID();

      await prisma.$executeRawUnsafe(`
        INSERT INTO permissions (id, slug, name, description, module)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug) DO NOTHING;
      `, id, slug, name, description, moduleName);

      console.log(`Ensured permission exists: ${slug}`);
    }
  }

  console.log('Seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
