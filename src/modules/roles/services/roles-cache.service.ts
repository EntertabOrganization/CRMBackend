import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleWithPermissions } from '../interfaces/roles-repository.interface';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class RolesCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly configService: ConfigService,
  ) {}

  getRole(companyId: string, id: string): RoleWithPermissions | null {
    return this.get<RoleWithPermissions>(this.buildRoleKey(companyId, id));
  }

  setRole(role: RoleWithPermissions): void {
    this.set(this.buildRoleKey(role.companyId, role.id), role);
  }

  getCollection<T>(companyId: string, key: string): T | null {
    return this.get<T>(this.buildCollectionKey(companyId, key));
  }

  setCollection<T>(companyId: string, key: string, value: T): void {
    this.set(this.buildCollectionKey(companyId, key), value);
  }

  invalidateRole(companyId: string, id: string): void {
    this.store.delete(this.buildRoleKey(companyId, id));
    this.invalidateCollections(companyId);
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
    const cacheTtlMs = this.configService.getOrThrow<number>('roles.cacheTtlMs');

    this.store.set(key, {
      value,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  private invalidateCollections(companyId: string): void {
    const prefix = `roles:list:${companyId}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  private buildRoleKey(companyId: string, id: string): string {
    return `roles:item:${companyId}:${id}`;
  }

  private buildCollectionKey(companyId: string, key: string): string {
    return `roles:list:${companyId}:${key}`;
  }
}
