export interface RepositoryFindOptions {
  includeDeleted?: boolean;
}

export interface FindManyParams<TWhereInput, TOrderByInput> {
  where?: TWhereInput;
  skip?: number;
  take?: number;
  orderBy?: TOrderByInput;
}

export interface BaseRepository<
  TEntity,
  TWhereInput,
  TCreateInput,
  TUpdateInput,
  TOrderByInput,
  TUniqueWhereInput,
> {
  findById(id: string, options?: RepositoryFindOptions): Promise<TEntity | null>;
  findOne(where: TWhereInput, options?: RepositoryFindOptions): Promise<TEntity | null>;
  findMany(params: FindManyParams<TWhereInput, TOrderByInput>, options?: RepositoryFindOptions): Promise<TEntity[]>;
  count(where?: TWhereInput, options?: RepositoryFindOptions): Promise<number>;
  create(data: TCreateInput): Promise<TEntity>;
  update(where: TUniqueWhereInput, data: TUpdateInput): Promise<TEntity>;
  delete(where: TUniqueWhereInput): Promise<TEntity>;
}
