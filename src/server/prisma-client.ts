import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & { __trueAgentPrisma?: PrismaClient };

export const prisma = globalForPrisma.__trueAgentPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__trueAgentPrisma = prisma;
}
