import { loadConfig } from './config.js';

interface CacheEntry<T> {
  key: string;
  value: T;
  bytes: number;
}

export class LruCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private bytes = 0;

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, bytes: number, maxFiles: number, maxBytes: number): void {
    if (maxFiles <= 0 || maxBytes <= 0) return;
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.entries.delete(key);
    }
    const entry = { key, value, bytes: Math.max(1, bytes) };
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.evict(maxFiles, maxBytes);
  }

  stats() {
    return { entries: this.entries.size, approximateBytes: this.bytes };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(maxFiles: number, maxBytes: number): void {
    while (this.entries.size > maxFiles || this.bytes > maxBytes) {
      const oldest = this.entries.values().next().value as CacheEntry<unknown> | undefined;
      if (!oldest) return;
      this.entries.delete(oldest.key);
      this.bytes -= oldest.bytes;
    }
  }
}

const runtimeCache = new LruCache();

export function cacheStats() {
  return runtimeCache.stats();
}

export function clearRuntimeCache(): void {
  runtimeCache.clear();
}

export async function cachedValue<T>(
  root: string,
  key: string,
  bytes: number | ((value: T) => number),
  factory: () => Promise<T>,
  isFresh?: (value: T) => Promise<boolean> | boolean,
): Promise<T> {
  const config = await loadConfig(root);
  if (!config.cache.enabled) return factory();
  const hit = runtimeCache.get<T>(key);
  if (hit !== undefined && (!isFresh || await isFresh(hit))) return hit;
  const value = await factory();
  const resolvedBytes = typeof bytes === 'function' ? bytes(value) : bytes;
  runtimeCache.set(key, value, resolvedBytes, config.cache.maxFiles, config.cache.maxBytes);
  return value;
}
