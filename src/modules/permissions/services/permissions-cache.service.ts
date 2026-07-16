import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Permission } from '@prisma/client';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class PermissionsCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly configService: ConfigService,
  ) {}

  getPermission(id: string): Permission | null {
    return this.get<Permission>(this.buildPermissionKey(id));
  }

  setPermission(permission: Permission): void {
    this.set(this.buildPermissionKey(permission.id), permission);
  }

  getCollection<T>(key: string): T | null {
    return this.get<T>(this.buildCollectionKey(key));
  }

  setCollection<T>(key: string, value: T): void {
    this.set(this.buildCollectionKey(key), value);
  }

  invalidatePermission(id: string): void {
    this.store.delete(this.buildPermissionKey(id));
    this.invalidateCollections();
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
    const cacheTtlMs = this.configService.getOrThrow<number>('permissions.cacheTtlMs');

    this.store.set(key, {
      value,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  private invalidateCollections(): void {
    for (const key of this.store.keys()) {
      if (key.startsWith('permissions:list:')) {
        this.store.delete(key);
      }
    }
  }

  private buildPermissionKey(id: string): string {
    return `permissions:item:${id}`;
  }

  private buildCollectionKey(key: string): string {
    return `permissions:list:${key}`;
  }
}
