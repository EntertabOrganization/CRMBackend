import { registerSearchSource } from './search-service';

/** Built-in search sources for already-implemented modules. Only directory-safe fields are indexed. */
registerSearchSource({ entityType: 'site', aggregateTypes: ['SITE'],
  async load(tx, workspaceId, id) { const s = await tx.site.findFirst({ where: { workspaceId, id, archivedAt: null } }); return s && { title: s.name, text: `${s.name} ${s.subdomain} ${s.type}`, version: s.siteVersion }; },
  async list(tx, workspaceId, cursor, take) { return (await tx.site.findMany({ where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take, select: { id: true } })).map(r => r.id); } });
registerSearchSource({ entityType: 'hr.employee', aggregateTypes: ['HR_EMPLOYEE'], classification: 'INTERNAL',
  // Directory fields only; private HR data is sealed and never indexed.
  async load(tx, workspaceId, id) { const e = await tx.hrEmployee.findFirst({ where: { workspaceId, id } }); return e && { title: e.displayName, text: `${e.displayName} ${e.employeeNumber}`, version: e.version }; },
  async list(tx, workspaceId, cursor, take) { return (await tx.hrEmployee.findMany({ where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take, select: { id: true } })).map(r => r.id); } });
registerSearchSource({ entityType: 'marketing.campaign', aggregateTypes: ['MARKETING_CAMPAIGN'],
  async load(tx, workspaceId, id) { const c = await tx.marketingCampaign.findFirst({ where: { workspaceId, id } }); return c && { title: c.name, text: `${c.name} ${c.channel} ${c.status}`, version: c.version }; },
  async list(tx, workspaceId, cursor, take) { return (await tx.marketingCampaign.findMany({ where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take, select: { id: true } })).map(r => r.id); } });
