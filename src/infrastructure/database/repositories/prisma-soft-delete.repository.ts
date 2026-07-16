import { BaseRepository, FindManyParams, RepositoryFindOptions } from './base-repository.interface';

interface PrismaRepositoryDelegate<
  TEntity,
  TWhereInput,
  TCreateInput,
  TUpdateInput,
  TOrderByInput,
  TUniqueWhereInput,
> {
  findUnique(args: { where: TUniqueWhereInput }): Promise<TEntity | null>;
  findFirst(args: { where: TWhereInput }): Promise<TEntity | null>;
  findMany(args: FindManyParams<TWhereInput, TOrderByInput>): Promise<TEntity[]>;
  count(args: { where?: TWhereInput }): Promise<number>;
  create(args: { data: TCreateInput }): Promise<TEntity>;
  update(args: { where: TUniqueWhereInput; data: TUpdateInput }): Promise<TEntity>;
  delete(args: { where: TUniqueWhereInput }): Promise<TEntity>;
}

interface PrismaSoftDeleteRepositoryOptions<TUniqueWhereInput> {
  buildIdWhere: (id: string) => TUniqueWhereInput;
  softDeleteField?: string;
}

export abstract class PrismaSoftDeleteRepository<
  TEntity,
  TWhereInput,
  TCreateInput,
  TUpdateInput,
  TOrderByInput,
  TUniqueWhereInput,
> implements
    BaseRepository<TEntity, TWhereInput, TCreateInput, TUpdateInput, TOrderByInput, TUniqueWhereInput>
{
  private readonly softDeleteField: string;

  protected constructor(
    private readonly delegate: PrismaRepositoryDelegate<
      TEntity,
      TWhereInput,
      TCreateInput,
      TUpdateInput,
      TOrderByInput,
      TUniqueWhereInput
    >,
    private readonly options: PrismaSoftDeleteRepositoryOptions<TUniqueWhereInput>,
  ) {
    this.softDeleteField = options.softDeleteField ?? 'isDeleted';
  }

  findById(id: string, options: RepositoryFindOptions = {}): Promise<TEntity | null> {
    if (options.includeDeleted) {
      return this.delegate.findUnique({ where: this.options.buildIdWhere(id) });
    }

    return this.delegate.findFirst({
      where: this.applySoftDeleteFilter(this.options.buildIdWhere(id) as unknown as TWhereInput, options),
    });
  }

  findOne(where: TWhereInput, options: RepositoryFindOptions = {}): Promise<TEntity | null> {
    return this.delegate.findFirst({
      where: this.applySoftDeleteFilter(where, options),
    });
  }

  findMany(
    params: FindManyParams<TWhereInput, TOrderByInput>,
    options: RepositoryFindOptions = {},
  ): Promise<TEntity[]> {
    return this.delegate.findMany({
      ...params,
      where: this.applySoftDeleteFilter(params.where, options),
    });
  }

  count(where?: TWhereInput, options: RepositoryFindOptions = {}): Promise<number> {
    return this.delegate.count({
      where: this.applySoftDeleteFilter(where, options),
    });
  }

  create(data: TCreateInput): Promise<TEntity> {
    return this.delegate.create({ data });
  }

  update(where: TUniqueWhereInput, data: TUpdateInput): Promise<TEntity> {
    return this.delegate.update({
      where,
      data,
    });
  }

  delete(where: TUniqueWhereInput): Promise<TEntity> {
    return this.delegate.delete({
      where,
    });
  }

  protected findUnique(where: TUniqueWhereInput): Promise<TEntity | null> {
    return this.delegate.findUnique({ where });
  }

  private applySoftDeleteFilter(where?: TWhereInput, options: RepositoryFindOptions = {}): TWhereInput {
    if (options.includeDeleted) {
      return (where ?? {}) as TWhereInput;
    }

    return {
      ...((where ?? {}) as Record<string, unknown>),
      [this.softDeleteField]: false,
    } as TWhereInput;
  }
}
