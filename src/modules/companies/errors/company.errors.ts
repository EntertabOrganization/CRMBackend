export const COMPANY_ERRORS = {
  NOT_FOUND: (id?: string) => `Company${id ? ` with ID ${id}` : ''} not found.`,
  OWNER_NOT_FOUND: (ownerId?: string) => `Owner user${ownerId ? ` with ID ${ownerId}` : ''} not found.`,
  USER_ALREADY_HAS_COMPANY: (ownerId?: string) =>
    `User${ownerId ? ` with ID ${ownerId}` : ''} already owns a company.`,
  ALREADY_DELETED: (id?: string) => `Company${id ? ` with ID ${id}` : ''} is already soft deleted.`,
  ALREADY_ACTIVE: (id?: string) => `Company${id ? ` with ID ${id}` : ''} is already active.`,
  SCHEMA_OUTDATED: 'Database schema is out of date for the Companies module. Apply the latest Prisma migration.',
};
