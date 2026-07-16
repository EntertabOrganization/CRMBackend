export const USER_ERRORS = {
  NOT_FOUND: (id?: string) => `User${id ? ` with ID ${id}` : ''} not found.`,
  EMAIL_ALREADY_EXISTS: (email?: string) => `User${email ? ` with email ${email}` : ''} already exists.`,
  ALREADY_DELETED: (id?: string) => `User${id ? ` with ID ${id}` : ''} is already soft deleted.`,
  ALREADY_ACTIVE: (id?: string) => `User${id ? ` with ID ${id}` : ''} is already active.`,
  UNAUTHORIZED_COMPANY_SCOPE: (id?: string, companyId?: string) =>
    `User${id ? ` with ID ${id}` : ''} does not belong to company scope${companyId ? ` ${companyId}` : ' unassigned'}.`,
  INVALID_CREDENTIALS: 'Invalid email or password.',
  ROLE_NOT_ASSIGNED_NOT_FOUND: 'NoCompanyRole was not found. Run scripts/Seeding/seed-noCompanyRole.ts first.',
  ROLE_SCOPE_INVALID: 'One or more roles were not found or do not belong to the requested company scope.',
  COMPANY_PAYLOAD_INCOMPLETE: 'companyName and companyCategory are required when creating a company during signup.',
  GOOGLE_AUTH_NOT_IMPLEMENTED: 'Google authentication is not configured in this environment.',
  SCHEMA_OUTDATED: 'Database schema is out of date for the Users module. Apply the latest Prisma migration.',
};
