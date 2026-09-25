import type { User } from '../domain';
import { AppError, badRequest, conflict } from '../errors';
import { applyQuery } from '../query';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, isPlainObject, normalizeCode, normalizeName, optionalBoolean, optionalInt, optionalText, requiredText } from './support';
import type { Catalog, CatalogCategory } from './types';
import { CATALOG_PERMISSIONS as P } from './types';

const MAX_CATEGORY_DEPTH = 10;

function pageParams(searchParams: URLSearchParams) {
  return {
    page: Math.max(Number(searchParams.get('page') ?? '1') || 1, 1),
    limit: Math.min(Math.max(Number(searchParams.get('limit') ?? '20') || 20, 1), 100),
    sortOrder: (searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc',
    search: searchParams.get('search') ?? undefined,
    sortBy: searchParams.get('sortBy') ?? undefined,
  };
}

/** Catalogs: several per workspace, exactly one designated default (a single settings row makes "exactly one" structural). */
export class CatalogService {
  constructor(private readonly support: CatalogSupport) {}

  private get state() {
    return this.support.state;
  }

  toDto(catalog: Catalog, defaultCatalogId: string | null) {
    return {
      id: catalog.id,
      name: catalog.name,
      code: catalog.code,
      description: catalog.description,
      isDefault: catalog.id === defaultCatalogId,
      isActive: catalog.isActive,
      sortOrder: catalog.sortOrder,
      productCount: this.state.catalogProducts.filter((product) => product.catalogId === catalog.id && product.type !== 'VARIANT').length,
      version: catalog.version,
      createdAt: catalog.createdAt,
      updatedAt: catalog.updatedAt,
    };
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    const settings = this.support.settings(workspaceId);
    const params = pageParams(searchParams);
    const isActive = searchParams.get('isActive');
    const rows = this.state.catalogs.filter(
      (catalog) => catalog.workspaceId === workspaceId && (isActive === null || catalog.isActive === (isActive === 'true')),
    );
    const result = applyQuery(rows as unknown as Array<Catalog & Record<string, unknown>>, {
      search: params.search,
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy as never,
      sortOrder: params.sortOrder,
    }, { searchable: ['name', 'code'], filterable: [], sortable: ['sortOrder', 'name', 'createdAt'], defaultSortBy: 'sortOrder' });
    return { data: (result.data as Catalog[]).map((catalog) => this.toDto(catalog, settings.defaultCatalogId)), meta: result.meta };
  }

  get(user: User, workspaceId: string, catalogId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    const settings = this.support.settings(workspaceId);
    return this.toDto(this.support.catalog(workspaceId, catalogId), settings.defaultCatalogId);
  }

  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.catalogManage);
    assertOnlyKeys(input, ['name', 'code', 'description', 'sortOrder', 'isActive', 'idempotencyKey'], 'catalog');
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const name = requiredText(input.name, 'name', 200);
      const code = input.code === undefined || input.code === null ? null : normalizeCode(input.code);
      this.assertUnique(workspaceId, name, code);
      const now = new Date();
      const catalog: Catalog = {
        id: this.support.store.id(),
        workspaceId,
        name,
        normalizedName: normalizeName(name),
        code,
        description: optionalText(input.description, 'description', 2000),
        isActive: optionalBoolean(input.isActive, 'isActive') ?? true,
        sortOrder: optionalInt(input.sortOrder, 'sortOrder', 0, 100000) ?? this.state.catalogs.filter((row) => row.workspaceId === workspaceId).length,
        version: 1,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
        createdAt: now,
        updatedAt: now,
      };
      this.state.catalogs.push(catalog);
      this.support.audit(actor, 'CATALOG.CREATED', 'Catalog', catalog.id, null, { name: catalog.name, code: catalog.code });
      this.support.emit(workspaceId, actor.user.id, 'CATALOG_CREATED', 'CATALOG', catalog.id, { version: catalog.version });
      return this.toDto(catalog, settings.defaultCatalogId);
    });
  }

  update(user: User, workspaceId: string, catalogId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.catalogManage);
    assertOnlyKeys(input, ['version', 'name', 'code', 'description', 'sortOrder', 'isActive'], 'catalog');
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      this.support.assertVersion(catalog.version, input.version, 'catalog');
      const before = { name: catalog.name, code: catalog.code, isActive: catalog.isActive, sortOrder: catalog.sortOrder };
      const name = input.name === undefined ? catalog.name : requiredText(input.name, 'name', 200);
      const code = input.code === undefined ? catalog.code : input.code === null ? null : normalizeCode(input.code);
      if (name !== catalog.name || code !== catalog.code) this.assertUnique(workspaceId, name, code, catalog.id);
      const isActive = optionalBoolean(input.isActive, 'isActive');
      if (isActive === false && catalog.id === settings.defaultCatalogId) {
        throw conflict('DEFAULT_CATALOG_REQUIRED', 'The default Catalog cannot be deactivated. Designate another default first.');
      }
      catalog.name = name;
      catalog.normalizedName = normalizeName(name);
      catalog.code = code;
      if (input.description !== undefined) catalog.description = optionalText(input.description, 'description', 2000);
      if (input.sortOrder !== undefined) catalog.sortOrder = optionalInt(input.sortOrder, 'sortOrder', 0, 100000)!;
      if (isActive !== undefined) catalog.isActive = isActive;
      catalog.version += 1;
      catalog.updatedAt = new Date();
      catalog.updatedByUserId = actor.user.id;
      this.support.audit(actor, 'CATALOG.UPDATED', 'Catalog', catalog.id, before, { name: catalog.name, code: catalog.code, isActive: catalog.isActive, sortOrder: catalog.sortOrder });
      this.support.emit(workspaceId, actor.user.id, 'CATALOG_UPDATED', 'CATALOG', catalog.id, { version: catalog.version });
      return this.toDto(catalog, settings.defaultCatalogId);
    });
  }

  /** Atomically designates the default: one settings row is rewritten, so there is never zero or two defaults. */
  setDefault(user: User, workspaceId: string, catalogId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.catalogManage);
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      if (!catalog.isActive) throw conflict('CATALOG_INACTIVE', 'An inactive Catalog cannot be the default.');
      if (settings.defaultCatalogId !== catalog.id) {
        const previous = settings.defaultCatalogId;
        settings.defaultCatalogId = catalog.id;
        settings.version += 1;
        settings.updatedAt = new Date();
        this.support.audit(actor, 'CATALOG.DEFAULT_CHANGED', 'Catalog', catalog.id, { defaultCatalogId: previous }, { defaultCatalogId: catalog.id });
        this.support.emit(workspaceId, actor.user.id, 'CATALOG_DEFAULT_CHANGED', 'CATALOG', catalog.id, { previousCatalogId: previous ?? '' });
      }
      return this.toDto(catalog, settings.defaultCatalogId);
    });
  }

  private assertUnique(workspaceId: string, name: string, code: string | null, exceptId?: string) {
    const normalized = normalizeName(name);
    for (const row of this.state.catalogs) {
      if (row.workspaceId !== workspaceId || row.id === exceptId) continue;
      if (row.normalizedName === normalized) throw conflict('CATALOG_NAME_CONFLICT', 'A Catalog with this name already exists.');
      if (code && row.code === code) throw conflict('CATALOG_CODE_CONFLICT', 'A Catalog with this code already exists.');
    }
  }
}

/** Category hierarchy inside one Catalog. Cycles, cross-Catalog parents and orphaning deletes are structurally impossible. */
export class CategoryService {
  constructor(private readonly support: CatalogSupport) {}

  private get state() {
    return this.support.state;
  }

  category(workspaceId: string, catalogId: string, categoryId: unknown): CatalogCategory {
    const row =
      typeof categoryId === 'string'
        ? this.state.catalogCategories.find((item) => item.id === categoryId && item.workspaceId === workspaceId && item.catalogId === catalogId)
        : undefined;
    if (!row) throw new AppError('CATEGORY_NOT_FOUND', 'Category was not found.', 404);
    return row;
  }

  toDto(category: CatalogCategory) {
    return {
      id: category.id,
      catalogId: category.catalogId,
      parentId: category.parentId,
      name: category.name,
      code: category.code,
      description: category.description,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      childCount: this.state.catalogCategories.filter((row) => row.parentId === category.id).length,
      productCount: this.state.catalogProductCategories.filter((row) => row.categoryId === category.id).length,
      version: category.version,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    };
  }

  private siblings(workspaceId: string, catalogId: string, parentId: string | null) {
    return this.state.catalogCategories
      .filter((row) => row.workspaceId === workspaceId && row.catalogId === catalogId && (row.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private depthOf(categoryId: string | null): number {
    let depth = 0;
    let cursor = categoryId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) return MAX_CATEGORY_DEPTH + 1;
      seen.add(cursor);
      depth += 1;
      cursor = this.state.catalogCategories.find((row) => row.id === cursor)?.parentId ?? null;
    }
    return depth;
  }

  descendantIds(categoryId: string): Set<string> {
    const found = new Set<string>();
    const walk = (id: string) => {
      for (const child of this.state.catalogCategories) {
        if (child.parentId === id && !found.has(child.id)) {
          found.add(child.id);
          walk(child.id);
        }
      }
    };
    walk(categoryId);
    return found;
  }

  list(user: User, workspaceId: string, catalogId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    this.support.settings(workspaceId);
    const catalog = this.support.catalog(workspaceId, catalogId);
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const rows = this.state.catalogCategories
      .filter((row) => row.workspaceId === workspaceId && row.catalogId === catalog.id && (includeInactive || row.isActive))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const dtos = rows.map((row) => this.toDto(row));
    if (searchParams.get('format') !== 'tree') return { data: dtos, meta: null };
    const byParent = new Map<string | null, Array<(typeof dtos)[number] & { children: unknown[] }>>();
    for (const dto of dtos) {
      const node = { ...dto, children: [] as unknown[] };
      const list = byParent.get(dto.parentId ?? null) ?? [];
      list.push(node);
      byParent.set(dto.parentId ?? null, list);
    }
    const attach = (nodes: Array<(typeof dtos)[number] & { children: unknown[] }>) => {
      for (const node of nodes) {
        node.children = byParent.get(node.id) ?? [];
        attach(node.children as typeof nodes);
      }
    };
    const roots = byParent.get(null) ?? [];
    attach(roots);
    return { data: roots, meta: null };
  }

  get(user: User, workspaceId: string, catalogId: string, categoryId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    this.support.settings(workspaceId);
    const catalog = this.support.catalog(workspaceId, catalogId);
    return this.toDto(this.category(workspaceId, catalog.id, categoryId));
  }

  create(user: User, workspaceId: string, catalogId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.categoryManage);
    assertOnlyKeys(input, ['name', 'code', 'description', 'parentId', 'sortOrder', 'isActive'], 'category');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      const parentId = this.resolveParent(workspaceId, catalog.id, input.parentId);
      if (this.depthOf(parentId) + 1 > MAX_CATEGORY_DEPTH) throw badRequest('CATEGORY_TOO_DEEP', `Categories can be nested at most ${MAX_CATEGORY_DEPTH} levels deep.`);
      const name = requiredText(input.name, 'name', 200);
      const code = input.code === undefined || input.code === null ? null : normalizeCode(input.code);
      this.assertUniqueCode(catalog.id, code);
      const now = new Date();
      const siblings = this.siblings(workspaceId, catalog.id, parentId);
      const category: CatalogCategory = {
        id: this.support.store.id(),
        workspaceId,
        catalogId: catalog.id,
        parentId,
        name,
        code,
        description: optionalText(input.description, 'description', 2000),
        sortOrder: optionalInt(input.sortOrder, 'sortOrder', 0, 1_000_000) ?? (siblings.length ? Math.max(...siblings.map((row) => row.sortOrder)) + 1 : 0),
        isActive: optionalBoolean(input.isActive, 'isActive') ?? true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.state.catalogCategories.push(category);
      this.support.audit(actor, 'CATEGORY.CREATED', 'CatalogCategory', category.id, null, { catalogId: catalog.id, name, parentId });
      this.support.emit(workspaceId, actor.user.id, 'CATEGORY_CHANGED', 'CATEGORY', category.id, { catalogId: catalog.id, change: 'CREATED' });
      return this.toDto(category);
    });
  }

  update(user: User, workspaceId: string, catalogId: string, categoryId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.categoryManage);
    assertOnlyKeys(input, ['version', 'name', 'code', 'description', 'isActive', 'sortOrder'], 'category');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      const category = this.category(workspaceId, catalog.id, categoryId);
      this.support.assertVersion(category.version, input.version, 'category');
      const before = { name: category.name, code: category.code, isActive: category.isActive, sortOrder: category.sortOrder };
      if (input.name !== undefined) category.name = requiredText(input.name, 'name', 200);
      if (input.code !== undefined) {
        const code = input.code === null ? null : normalizeCode(input.code);
        this.assertUniqueCode(catalog.id, code, category.id);
        category.code = code;
      }
      if (input.description !== undefined) category.description = optionalText(input.description, 'description', 2000);
      if (input.sortOrder !== undefined) category.sortOrder = optionalInt(input.sortOrder, 'sortOrder', 0, 1_000_000)!;
      const isActive = optionalBoolean(input.isActive, 'isActive');
      if (isActive !== undefined) category.isActive = isActive;
      category.version += 1;
      category.updatedAt = new Date();
      this.support.audit(actor, 'CATEGORY.UPDATED', 'CatalogCategory', category.id, before, { name: category.name, code: category.code, isActive: category.isActive, sortOrder: category.sortOrder });
      this.support.emit(workspaceId, actor.user.id, 'CATEGORY_CHANGED', 'CATEGORY', category.id, { catalogId: catalog.id, change: 'UPDATED' });
      return this.toDto(category);
    });
  }

  /** Moving validates scope, self-parenting and descendant cycles before anything is written. */
  move(user: User, workspaceId: string, catalogId: string, categoryId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.categoryManage);
    assertOnlyKeys(input, ['parentId', 'position', 'version'], 'category move');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      const category = this.category(workspaceId, catalog.id, categoryId);
      if (input.version !== undefined) this.support.assertVersion(category.version, input.version, 'category');
      if (!('parentId' in input)) throw badRequest('VALIDATION_ERROR', 'parentId is required (null moves the category to the root).', { field: 'parentId' });
      const parentId = this.resolveParent(workspaceId, catalog.id, input.parentId);
      if (parentId === category.id || (parentId && this.descendantIds(category.id).has(parentId))) {
        throw conflict('CATEGORY_CYCLE', 'A category cannot be moved under itself or one of its descendants.');
      }
      const subtreeDepth = this.subtreeHeight(category.id);
      if (this.depthOf(parentId) + subtreeDepth > MAX_CATEGORY_DEPTH) throw badRequest('CATEGORY_TOO_DEEP', `Categories can be nested at most ${MAX_CATEGORY_DEPTH} levels deep.`);
      const before = { parentId: category.parentId, sortOrder: category.sortOrder };
      const others = this.siblings(workspaceId, catalog.id, parentId).filter((row) => row.id !== category.id);
      const position = optionalInt(input.position, 'position', 0, others.length) ?? others.length;
      category.parentId = parentId;
      const ordered = [...others.slice(0, position), category, ...others.slice(position)];
      ordered.forEach((row, index) => {
        if (row.sortOrder !== index) {
          row.sortOrder = index;
          row.version += row.id === category.id ? 0 : 1;
          row.updatedAt = new Date();
        }
      });
      category.version += 1;
      category.updatedAt = new Date();
      this.support.audit(actor, 'CATEGORY.MOVED', 'CatalogCategory', category.id, before, { parentId: category.parentId, sortOrder: category.sortOrder });
      this.support.emit(workspaceId, actor.user.id, 'CATEGORY_CHANGED', 'CATEGORY', category.id, { catalogId: catalog.id, change: 'MOVED' });
      return this.toDto(category);
    });
  }

  /** Atomic sibling reorder: the request must name exactly the current siblings, so concurrent edits cannot half-apply. */
  reorder(user: User, workspaceId: string, catalogId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.categoryManage);
    assertOnlyKeys(input, ['parentId', 'orderedIds'], 'category reorder');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      const parentId = this.resolveParent(workspaceId, catalog.id, input.parentId ?? null);
      const ordered = input.orderedIds;
      if (!Array.isArray(ordered) || ordered.some((id) => typeof id !== 'string')) throw badRequest('VALIDATION_ERROR', 'orderedIds must be an array of category ids.', { field: 'orderedIds' });
      const siblings = this.siblings(workspaceId, catalog.id, parentId);
      const expected = new Set(siblings.map((row) => row.id));
      if (ordered.length !== expected.size || new Set(ordered).size !== ordered.length || ordered.some((id) => !expected.has(id as string))) {
        throw badRequest('CATEGORY_REORDER_INVALID', 'orderedIds must list exactly the current sibling categories.', { expectedIds: [...expected] });
      }
      const byId = new Map(siblings.map((row) => [row.id, row]));
      (ordered as string[]).forEach((id, index) => {
        const row = byId.get(id)!;
        if (row.sortOrder !== index) {
          row.sortOrder = index;
          row.version += 1;
          row.updatedAt = new Date();
        }
      });
      this.support.audit(actor, 'CATEGORY.REORDERED', 'CatalogCategory', catalog.id, null, { parentId, orderedIds: ordered });
      this.support.emit(workspaceId, actor.user.id, 'CATEGORY_CHANGED', 'CATEGORY', catalog.id, { catalogId: catalog.id, change: 'REORDERED' });
      return { parentId, orderedIds: ordered };
    });
  }

  /** Deletion never cascades: children and Product memberships must be moved/reassigned first. */
  remove(user: User, workspaceId: string, catalogId: string, categoryId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.categoryManage);
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const catalog = this.support.catalog(workspaceId, catalogId);
      const category = this.category(workspaceId, catalog.id, categoryId);
      const dependencies = this.dependencies(category);
      if (dependencies.childCategoryIds.length > 0 || dependencies.productCount > 0 || dependencies.propertyProfileIds.length > 0) {
        throw conflict('CATEGORY_HAS_DEPENDENCIES', 'The category still has child categories or Products. Move or reassign them first.', {
          ...dependencies,
          remediation: 'Move child categories, reassign the listed Products to another category, then delete the empty category.',
        });
      }
      this.state.catalogCategories = this.state.catalogCategories.filter((row) => row.id !== category.id);
      this.support.audit(actor, 'CATEGORY.DELETED', 'CatalogCategory', category.id, { catalogId: catalog.id, name: category.name }, null);
      this.support.emit(workspaceId, actor.user.id, 'CATEGORY_CHANGED', 'CATEGORY', category.id, { catalogId: catalog.id, change: 'DELETED' });
      return { id: category.id, deleted: true };
    });
  }

  dependencies(category: CatalogCategory) {
    const memberships = this.state.catalogProductCategories.filter((row) => row.categoryId === category.id);
    return {
      childCategoryIds: this.state.catalogCategories.filter((row) => row.parentId === category.id).map((row) => row.id),
      productCount: memberships.length,
      sampleProductIds: memberships.slice(0, 20).map((row) => row.productId),
      propertyProfileIds: this.state.catalogPropertyProfiles.filter((row) => row.categoryIds.includes(category.id)).map((row) => row.id),
    };
  }

  private subtreeHeight(categoryId: string): number {
    const children = this.state.catalogCategories.filter((row) => row.parentId === categoryId);
    return 1 + (children.length ? Math.max(...children.map((child) => this.subtreeHeight(child.id))) : 0);
  }

  private resolveParent(workspaceId: string, catalogId: string, parentId: unknown): string | null {
    if (parentId === undefined || parentId === null) return null;
    if (typeof parentId !== 'string') throw badRequest('VALIDATION_ERROR', 'parentId must be a category id or null.', { field: 'parentId' });
    // A parent from another workspace or Catalog is reported exactly like a missing one.
    const parent = this.state.catalogCategories.find((row) => row.id === parentId && row.workspaceId === workspaceId && row.catalogId === catalogId);
    if (!parent) throw new AppError('CATEGORY_NOT_FOUND', 'Parent category was not found in this Catalog.', 404);
    return parent.id;
  }

  private assertUniqueCode(catalogId: string, code: string | null, exceptId?: string) {
    if (!code) return;
    if (this.state.catalogCategories.some((row) => row.catalogId === catalogId && row.code === code && row.id !== exceptId)) {
      throw conflict('CATEGORY_CODE_CONFLICT', 'A category with this code already exists in the Catalog.');
    }
  }

  /** Validation used by Product writes: every membership must belong to the Product's own Catalog and workspace. */
  assertAssignable(workspaceId: string, catalogId: string, categoryIds: string[]) {
    for (const id of categoryIds) {
      const row = this.state.catalogCategories.find((item) => item.id === id && item.workspaceId === workspaceId && item.catalogId === catalogId);
      if (!row) throw new AppError('CATEGORY_NOT_FOUND', 'A category was not found in the Product\'s Catalog.', 404, { categoryId: id });
      if (!row.isActive) throw conflict('CATEGORY_INACTIVE', 'An inactive category cannot receive Products.', { categoryId: id });
    }
  }
}

export { isPlainObject };
