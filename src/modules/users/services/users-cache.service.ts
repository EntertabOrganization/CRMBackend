import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserWithRelations } from '../interfaces/users-repository.interface';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class UsersCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly configService: ConfigService,
  ) {}

  getUser(scopeKey: string, id: string): UserWithRelations | null {
    return this.get<UserWithRelations>(this.buildUserKey(scopeKey, id));
  }

  setUser(user: UserWithRelations): void {
    this.set(this.buildUserKey(this.buildScopeKey(user.companyId), user.id), user);
  }

  getCollection<T>(scopeKey: string, key: string): T | null {
    return this.get<T>(this.buildCollectionKey(scopeKey, key));
  }

  setCollection<T>(scopeKey: string, key: string, value: T): void {
    this.set(this.buildCollectionKey(scopeKey, key), value);
  }

  invalidateUser(scopeKey: string, id: string): void {
    this.store.delete(this.buildUserKey(scopeKey, id));
    this.invalidateCollections(scopeKey);
  }

  buildScopeKey(companyId?: string | null): string {
    return companyId ?? 'unassigned';
  }

  private get<T>(key: string): T | null {
    const entry = this.store.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value as T;
  }

  private set<T>(key: string, value: T): void {
    const cacheTtlMs = this.configService.getOrThrow<number>('users.cacheTtlMs');

    this.store.set(key, {
      value,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  private invalidateCollections(scopeKey: string): void {
    const prefix = `users:list:${scopeKey}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  private buildUserKey(scopeKey: string, id: string): string {
    return `users:item:${scopeKey}:${id}`;
  }

  private buildCollectionKey(scopeKey: string, key: string): string {
    return `users:list:${scopeKey}:${key}`;
  }
}
