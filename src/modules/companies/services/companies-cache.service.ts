import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Company } from '@prisma/client';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class CompaniesCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly configService: ConfigService,
  ) {}

  getCompany(id: string): Company | null {
    return this.get<Company>(this.buildCompanyKey(id));
  }

  setCompany(company: Company): void {
    this.set(this.buildCompanyKey(company.id), company);
  }

  getCollection<T>(key: string): T | null {
    return this.get<T>(this.buildCollectionKey(key));
  }

  setCollection<T>(key: string, value: T): void {
    this.set(this.buildCollectionKey(key), value);
  }

  invalidateCompany(id: string): void {
    this.store.delete(this.buildCompanyKey(id));
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
    const cacheTtlMs = this.configService.getOrThrow<number>('companies.cacheTtlMs');

    this.store.set(key, {
      value,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  private invalidateCollections(): void {
    for (const key of this.store.keys()) {
      if (key.startsWith('companies:list:')) {
        this.store.delete(key);
      }
    }
  }

  private buildCompanyKey(id: string): string {
    return `companies:item:${id}`;
  }

  private buildCollectionKey(key: string): string {
    return `companies:list:${key}`;
  }
}
