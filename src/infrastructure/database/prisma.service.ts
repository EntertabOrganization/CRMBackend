import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Returns an extended Prisma client that automatically filters by company_id.
   * This is used at the repository level.
   */
  getTenantClient(companyId: string, userId?: string) {
    const baseClient = this;
    return this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const extendedArgs = args as any;
            const modelSchema = (baseClient as any)._runtimeDataModel.models[model];
            const hasCompanyId = modelSchema?.fields.some((f: any) => f.name === 'companyId');
            const hasIsDeleted = modelSchema?.fields.some((f: any) => f.name === 'isDeleted');
            // Apply companyId filter to all find operations if the model has companyId
            if (
              ['findFirst', 'findMany', 'findUnique', 'count', 'update', 'updateMany', 'delete', 'deleteMany'].includes(
                operation,
              )
            ) {
              if (hasCompanyId) {
                extendedArgs.where = { ...extendedArgs.where, companyId };
              }
            }

            if (['findFirst', 'findMany', 'count'].includes(operation) && hasIsDeleted) {
              extendedArgs.where = { ...extendedArgs.where };
              if (!Object.prototype.hasOwnProperty.call(extendedArgs.where, 'isDeleted')) {
                extendedArgs.where.isDeleted = false;
              }
            }

            // Automatically inject companyId on create
            if (operation === 'create' || operation === 'createMany') {
              if (hasCompanyId) {
                if (operation === 'create') {
                  extendedArgs.data = { ...extendedArgs.data, companyId };
                } else if (Array.isArray(extendedArgs.data)) {
                  extendedArgs.data = extendedArgs.data.map((item: any) => ({ ...item, companyId }));
                }
              }
            }

            const result = await query(extendedArgs);

            // Audit logging disabled - AuditLog model not in use
            // if (['create', 'update', 'delete'].includes(operation) && model !== 'AuditLog') {
            //   const actionMap: Record<string, 'CREATED' | 'UPDATE' | 'DELETE'> = {
            //     create: 'CREATED',
            //     update: 'UPDATE',
            //     delete: 'DELETE',
            //   };
            //   const action = actionMap[operation];
            //   const referenceId = (result as any)?.id || extendedArgs?.where?.id || 'unknown';
            //
            //   try {
            //     await baseClient.auditLog.create({
            //       data: {
            //         companyId,
            //         referenceId: String(referenceId),
            //         action,
            //         description: `${model} was ${action.toLowerCase()}d.`,
            //         createdBy: userId || null,
            //       },
            //     });
            //   } catch (error) {
            //     console.error(`Failed to create AuditLog for ${model}:`, error);
            //   }
            // }

            return result;
          },
        },
      },
    });
  }
}
