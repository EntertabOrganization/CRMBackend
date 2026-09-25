import type { User } from '../domain';
import { badRequest, conflict } from '../errors';
import { applyQuery } from '../query';
import type { CatalogSupport, Json } from './support';
import { assertOnlyKeys, normalizeCode, optionalBoolean, optionalInt, optionalText, requiredText } from './support';
import type { CatalogUnit, PriceType } from './types';
import { CATALOG_PERMISSIONS as P } from './types';

function pageParams(searchParams: URLSearchParams) {
  return {
    page: Math.max(Number(searchParams.get('page') ?? '1') || 1, 1),
    limit: Math.min(Math.max(Number(searchParams.get('limit') ?? '50') || 50, 1), 100),
    sortOrder: (searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc',
    search: searchParams.get('search') ?? undefined,
    sortBy: searchParams.get('sortBy') ?? undefined,
  };
}

/** Reusable Units (Inventory/Commerce reuse the same records). Units in use are deactivated, never hard-deleted. */
export class UnitService {
  constructor(private readonly support: CatalogSupport) {}

  private get state() {
    return this.support.state;
  }

  toDto(unit: CatalogUnit) {
    return {
      id: unit.id,
      code: unit.code,
      name: unit.name,
      symbol: unit.symbol,
      precision: unit.precision,
      isActive: unit.isActive,
      isSystem: unit.isSystem,
      sortOrder: unit.sortOrder,
      version: unit.version,
    };
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    this.support.settings(workspaceId);
    const params = pageParams(searchParams);
    const isActive = searchParams.get('isActive');
    const rows = this.state.catalogUnits.filter((unit) => unit.workspaceId === workspaceId && (isActive === null || unit.isActive === (isActive === 'true')));
    const result = applyQuery(rows as unknown as Array<CatalogUnit & Record<string, unknown>>, {
      search: params.search,
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy as never,
      sortOrder: params.sortOrder,
    }, { searchable: ['code', 'name', 'symbol'], filterable: [], sortable: ['sortOrder', 'code', 'name'], defaultSortBy: 'sortOrder' });
    return { data: (result.data as CatalogUnit[]).map((unit) => this.toDto(unit)), meta: result.meta };
  }

  get(user: User, workspaceId: string, unitId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    this.support.settings(workspaceId);
    return this.toDto(this.support.unit(workspaceId, unitId));
  }

  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.unitManage);
    assertOnlyKeys(input, ['code', 'name', 'symbol', 'precision', 'sortOrder', 'isActive'], 'unit');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const code = normalizeCode(input.code);
      if (this.state.catalogUnits.some((unit) => unit.workspaceId === workspaceId && unit.code === code)) {
        throw conflict('UNIT_CODE_CONFLICT', 'A unit with this code already exists.');
      }
      const now = new Date();
      const unit: CatalogUnit = {
        id: this.support.store.id(),
        workspaceId,
        code,
        name: requiredText(input.name, 'name', 100),
        symbol: optionalText(input.symbol, 'symbol', 16),
        precision: optionalInt(input.precision, 'precision', 0, 8) ?? 6,
        isActive: optionalBoolean(input.isActive, 'isActive') ?? true,
        isSystem: false,
        sortOrder: optionalInt(input.sortOrder, 'sortOrder', 0, 100000) ?? this.state.catalogUnits.filter((row) => row.workspaceId === workspaceId).length,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.state.catalogUnits.push(unit);
      this.support.audit(actor, 'UNIT.CREATED', 'CatalogUnit', unit.id, null, { code: unit.code, name: unit.name });
      this.support.emit(workspaceId, actor.user.id, 'UNIT_CHANGED', 'UNIT', unit.id, { change: 'CREATED' });
      return this.toDto(unit);
    });
  }

  update(user: User, workspaceId: string, unitId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.unitManage);
    assertOnlyKeys(input, ['version', 'code', 'name', 'symbol', 'precision', 'sortOrder', 'isActive'], 'unit');
    return this.support.store.atomicSync(() => {
      this.support.settings(workspaceId);
      const unit = this.support.unit(workspaceId, unitId);
      this.support.assertVersion(unit.version, input.version, 'unit');
      // Codes are the stable identity Inventory/Commerce reference; renames change the label only.
      if (input.code !== undefined && normalizeCode(input.code) !== unit.code) throw badRequest('UNIT_CODE_IMMUTABLE', 'A unit code cannot be changed after creation.');
      const before = { name: unit.name, symbol: unit.symbol, isActive: unit.isActive };
      if (input.name !== undefined) unit.name = requiredText(input.name, 'name', 100);
      if (input.symbol !== undefined) unit.symbol = optionalText(input.symbol, 'symbol', 16);
      if (input.precision !== undefined) unit.precision = optionalInt(input.precision, 'precision', 0, 8)!;
      if (input.sortOrder !== undefined) unit.sortOrder = optionalInt(input.sortOrder, 'sortOrder', 0, 100000)!;
      const isActive = optionalBoolean(input.isActive, 'isActive');
      if (isActive !== undefined) unit.isActive = isActive;
      unit.version += 1;
      unit.updatedAt = new Date();
      this.support.audit(actor, 'UNIT.UPDATED', 'CatalogUnit', unit.id, before, { name: unit.name, symbol: unit.symbol, isActive: unit.isActive });
      this.support.emit(workspaceId, actor.user.id, 'UNIT_CHANGED', 'UNIT', unit.id, { change: 'UPDATED' });
      return this.toDto(unit);
    });
  }

  /** Default unit for new Products/Services when the request does not name one. */
  defaultUnitId(workspaceId: string, type: string): string | null {
    const code = type === 'SERVICE' ? 'HOUR' : 'PIECE';
    return this.state.catalogUnits.find((unit) => unit.workspaceId === workspaceId && unit.code === code && unit.isActive)?.id ?? null;
  }
}

/** Price Types: one mandatory base type (settings row) plus optional additional types. */
export class PriceTypeService {
  constructor(private readonly support: CatalogSupport) {}

  private get state() {
    return this.support.state;
  }

  toDto(type: PriceType, baseId: string | null) {
    return { id: type.id, code: type.code, name: type.name, isBase: type.id === baseId, isActive: type.isActive, sortOrder: type.sortOrder, version: type.version };
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    const settings = this.support.settings(workspaceId);
    const params = pageParams(searchParams);
    const isActive = searchParams.get('isActive');
    const rows = this.state.catalogPriceTypes.filter((type) => type.workspaceId === workspaceId && (isActive === null || type.isActive === (isActive === 'true')));
    const result = applyQuery(rows as unknown as Array<PriceType & Record<string, unknown>>, {
      search: params.search,
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy as never,
      sortOrder: params.sortOrder,
    }, { searchable: ['code', 'name'], filterable: [], sortable: ['sortOrder', 'code', 'name'], defaultSortBy: 'sortOrder' });
    return { data: (result.data as PriceType[]).map((type) => this.toDto(type, settings.basePriceTypeId)), meta: result.meta };
  }

  get(user: User, workspaceId: string, priceTypeId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireLookupRead(actor);
    const settings = this.support.settings(workspaceId);
    return this.toDto(this.support.priceType(workspaceId, priceTypeId), settings.basePriceTypeId);
  }

  create(user: User, workspaceId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.priceTypeManage);
    assertOnlyKeys(input, ['code', 'name', 'sortOrder', 'isActive'], 'price type');
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const code = normalizeCode(input.code);
      if (this.state.catalogPriceTypes.some((type) => type.workspaceId === workspaceId && type.code === code)) {
        throw conflict('PRICE_TYPE_CODE_CONFLICT', 'A price type with this code already exists.');
      }
      const now = new Date();
      const type: PriceType = {
        id: this.support.store.id(),
        workspaceId,
        code,
        name: requiredText(input.name, 'name', 100),
        isActive: optionalBoolean(input.isActive, 'isActive') ?? true,
        sortOrder: optionalInt(input.sortOrder, 'sortOrder', 0, 100000) ?? this.state.catalogPriceTypes.filter((row) => row.workspaceId === workspaceId).length,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.state.catalogPriceTypes.push(type);
      this.support.audit(actor, 'PRICE_TYPE.CREATED', 'CatalogPriceType', type.id, null, { code: type.code, name: type.name });
      this.support.emit(workspaceId, actor.user.id, 'PRICE_TYPE_CHANGED', 'PRICE_TYPE', type.id, { change: 'CREATED' });
      return this.toDto(type, settings.basePriceTypeId);
    });
  }

  update(user: User, workspaceId: string, priceTypeId: string, input: Json) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.priceTypeManage);
    assertOnlyKeys(input, ['version', 'code', 'name', 'sortOrder', 'isActive'], 'price type');
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const type = this.support.priceType(workspaceId, priceTypeId);
      this.support.assertVersion(type.version, input.version, 'price type');
      if (input.code !== undefined && normalizeCode(input.code) !== type.code) throw badRequest('PRICE_TYPE_CODE_IMMUTABLE', 'A price type code cannot be changed after creation.');
      const isActive = optionalBoolean(input.isActive, 'isActive');
      if (isActive === false && type.id === settings.basePriceTypeId) {
        throw conflict('BASE_PRICE_TYPE_REQUIRED', 'The base price type cannot be deactivated. Designate another base price type first.');
      }
      const before = { name: type.name, isActive: type.isActive, sortOrder: type.sortOrder };
      if (input.name !== undefined) type.name = requiredText(input.name, 'name', 100);
      if (input.sortOrder !== undefined) type.sortOrder = optionalInt(input.sortOrder, 'sortOrder', 0, 100000)!;
      if (isActive !== undefined) type.isActive = isActive;
      type.version += 1;
      type.updatedAt = new Date();
      this.support.audit(actor, 'PRICE_TYPE.UPDATED', 'CatalogPriceType', type.id, before, { name: type.name, isActive: type.isActive, sortOrder: type.sortOrder });
      this.support.emit(workspaceId, actor.user.id, 'PRICE_TYPE_CHANGED', 'PRICE_TYPE', type.id, { change: 'UPDATED' });
      return this.toDto(type, settings.basePriceTypeId);
    });
  }

  /** Switches the base type in one settings-row update, so the workspace never has zero or two base types. */
  setBase(user: User, workspaceId: string, priceTypeId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireManage(actor, P.priceTypeManage);
    return this.support.store.atomicSync(() => {
      const settings = this.support.settings(workspaceId);
      const type = this.support.priceType(workspaceId, priceTypeId);
      if (!type.isActive) throw conflict('PRICE_TYPE_INACTIVE', 'An inactive price type cannot be the base type.');
      if (settings.basePriceTypeId !== type.id) {
        const previous = settings.basePriceTypeId;
        settings.basePriceTypeId = type.id;
        settings.version += 1;
        settings.updatedAt = new Date();
        this.support.audit(actor, 'PRICE_TYPE.BASE_CHANGED', 'CatalogPriceType', type.id, { basePriceTypeId: previous }, { basePriceTypeId: type.id });
        this.support.emit(workspaceId, actor.user.id, 'PRICE_TYPE_CHANGED', 'PRICE_TYPE', type.id, { change: 'BASE_CHANGED', previousBasePriceTypeId: previous ?? '' });
      }
      return this.toDto(type, settings.basePriceTypeId);
    });
  }
}
