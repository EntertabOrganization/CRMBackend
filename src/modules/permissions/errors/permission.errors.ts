export const PERMISSION_ERRORS = {
  NOT_FOUND: (id?: string) => `Permission${id ? ` with ID ${id}` : ''} not found.`,
  SOFT_DELETED: (slug?: string) =>
    `Permission${slug ? ` with slug "${slug}"` : ''} already exists but is soft deleted.`,
  ALREADY_EXISTS: (slug?: string) => `Permission${slug ? ` with slug "${slug}"` : ''} already exists.`,
  ALREADY_DELETED: (id?: string) => `Permission${id ? ` with ID ${id}` : ''} is already soft deleted.`,
  ALREADY_ACTIVE: (id?: string) => `Permission${id ? ` with ID ${id}` : ''} is already active.`,
};
