export const ROLE_ERRORS = {
  NOT_FOUND: (id?: string) => `Role${id ? ` with ID ${id}` : ''} not found.`,
  ALREADY_EXISTS: (name?: string, companyId?: string) =>
    `Role${name ? ` "${name}"` : ''}${companyId ? ` already exists in company ${companyId}` : ' already exists'}.`,
  ALREADY_DELETED: (id?: string) => `Role${id ? ` with ID ${id}` : ''} is already soft deleted.`,
  ALREADY_ACTIVE: (id?: string) => `Role${id ? ` with ID ${id}` : ''} is already active.`,
  UNAUTHORIZED_COMPANY_SCOPE: (id?: string, companyId?: string) =>
    `Role${id ? ` with ID ${id}` : ''} does not belong to company${companyId ? ` ${companyId}` : ''}.`,
  PERMISSIONS_NOT_FOUND: 'One or more permissions were not found or are soft deleted.',
  SCHEMA_OUTDATED: 'Database schema is out of date for the Roles module. Apply the latest Prisma migration.',
};
