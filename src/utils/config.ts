import fs from 'node:fs/promises';
import path from 'node:path';
import { configureLanguageExtensions } from '../languages/registry.js';
import { CodeboneError, warning } from './errors.js';
import { resolveInsideRoot } from './paths.js';

export interface CodeboneConfig {
  defaultBudget: number;
  maxBudget: number;
  batchBudget: number;
  maxFiles: number;
  maxFileBytes: number;
  timeoutMs: number;
  cache: {
    enabled: boolean;
    maxFiles: number;
    maxBytes: number;
  };
  ignore: string[];
  testPatterns: string[];
  entrypoints: string[];
  include: string[];
  exclude: string[];
  languages: Record<string, { extensions?: string[] }>;
  security: {
    followSymlinks: boolean;
    allowOutsideRoot: boolean;
    redactSecrets: boolean;
  };
  budgets: {
    defaultToolTokens: number;
    maxReadBytes: number;
    maxFiles: number;
  };
  warnings: string[];
  source: 'defaults' | '.codebonerc.json' | 'package.json#codebone' | '.codebone.json' | 'cli';
  noCache: boolean;
}

type ConfigInput = Record<string, unknown>;

const defaults: CodeboneConfig = {
  defaultBudget: 8000,
  maxBudget: 50000,
  batchBudget: 50000,
  maxFiles: 10000,
  maxFileBytes: 1_048_576,
  timeoutMs: 30000,
  cache: { enabled: true, maxFiles: 5000, maxBytes: 67_108_864 },
  ignore: [],
  testPatterns: ['**/*.test.*', '**/*.spec.*', '__tests__/**', 'tests/**'],
  entrypoints: [],
  include: [],
  exclude: [],
  languages: {},
  security: { followSymlinks: true, allowOutsideRoot: false, redactSecrets: true },
  budgets: { defaultToolTokens: 12000, maxReadBytes: 65536, maxFiles: 200 },
  warnings: [],
  source: 'defaults',
  noCache: false,
};

const allowedTopLevel = new Set([
  'defaultBudget',
  'maxBudget',
  'batchBudget',
  'maxFiles',
  'maxFileBytes',
  'timeoutMs',
  'cache',
  'ignore',
  'testPatterns',
  'entrypoints',
  'include',
  'exclude',
  'languages',
  'security',
  'budgets',
  'schemaVersion',
]);

const cache = new Map<string, Promise<CodeboneConfig>>();
const configuredPaths = new Map<string, string>();
const cliOverrides = new Map<string, Partial<CodeboneConfig> & { ignore?: string[] }>();

export function setConfigPath(root: string, configPath: string | undefined): void {
  if (configPath) configuredPaths.set(root, configPath);
  clearConfigCache(root);
}

export function setConfigOverrides(root: string, overrides: Partial<CodeboneConfig> & { ignore?: string[] }): void {
  cliOverrides.set(root, overrides);
  clearConfigCache(root);
}

export function clearConfigCache(root?: string): void {
  if (!root) {
    cache.clear();
    configuredPaths.clear();
    cliOverrides.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${root}:`)) cache.delete(key);
  }
}

export async function loadConfig(root: string, configPath?: string): Promise<CodeboneConfig> {
  const resolvedConfigPath = configPath ?? configuredPaths.get(root);
  const key = `${root}:${resolvedConfigPath ?? '<auto>'}:${JSON.stringify(cliOverrides.get(root) ?? {})}`;
  if (!cache.has(key)) cache.set(key, readConfig(root, resolvedConfigPath));
  return cache.get(key)!;
}

export async function effectiveConfig(root: string, configPath?: string) {
  return { ...(await loadConfig(root, configPath)), root };
}

async function readConfig(root: string, configPath?: string): Promise<CodeboneConfig> {
  const { raw, source } = await readRawConfig(root, configPath);
  const warnings: string[] = [];
  const parsed = raw ? validateConfig(raw, source, warnings) : { ...defaults, source };
  const overrides = cliOverrides.get(root) ?? {};
  const merged: CodeboneConfig = {
    ...defaults,
    ...parsed,
    cache: { ...defaults.cache, ...parsed.cache },
    security: { ...defaults.security, ...parsed.security },
    budgets: { ...defaults.budgets, ...parsed.budgets },
    ignore: [...(parsed.ignore ?? []), ...(parsed.exclude ?? []), ...(overrides.ignore ?? [])],
    include: parsed.include ?? [],
    exclude: [...(parsed.exclude ?? []), ...(overrides.ignore ?? [])],
    testPatterns: parsed.testPatterns?.length ? parsed.testPatterns : defaults.testPatterns,
    entrypoints: parsed.entrypoints ?? [],
    warnings: [...warnings],
    source,
    noCache: Boolean(overrides.noCache),
  };

  if (overrides.defaultBudget !== undefined) merged.defaultBudget = overrides.defaultBudget;
  if (overrides.maxBudget !== undefined) merged.maxBudget = overrides.maxBudget;
  if (overrides.batchBudget !== undefined) merged.batchBudget = overrides.batchBudget;
  if (overrides.maxFiles !== undefined) merged.maxFiles = overrides.maxFiles;
  if (overrides.maxFileBytes !== undefined) merged.maxFileBytes = overrides.maxFileBytes;
  if (overrides.timeoutMs !== undefined) merged.timeoutMs = overrides.timeoutMs;
  if (overrides.cache) merged.cache = { ...merged.cache, ...overrides.cache };
  if (merged.noCache) merged.cache.enabled = false;

  validateBudgetRelationships(merged);
  configureLanguageExtensions(merged.languages);
  return merged;
}

async function readRawConfig(root: string, configPath?: string): Promise<{ raw?: ConfigInput; source: CodeboneConfig['source'] }> {
  if (configPath) return { raw: await readJson(resolveInsideRoot(root, configPath), configPath), source: 'cli' };

  const codebonerc = path.join(root, '.codebonerc.json');
  if (await exists(codebonerc)) return { raw: await readJson(codebonerc, '.codebonerc.json'), source: '.codebonerc.json' };

  const packageJson = path.join(root, 'package.json');
  if (await exists(packageJson)) {
    const packageData = await readJson(packageJson, 'package.json');
    const packageConfig = packageData.codebone;
    if (packageConfig !== undefined) {
      if (!isObject(packageConfig)) throw new CodeboneError('CONFIG_INVALID', 'package.json#codebone must be an object');
      return { raw: packageConfig, source: 'package.json#codebone' };
    }
  }

  const legacy = path.join(root, '.codebone.json');
  if (await exists(legacy)) return { raw: await readJson(legacy, '.codebone.json'), source: '.codebone.json' };

  return { source: 'defaults' };
}

async function readJson(filePath: string, label: string): Promise<ConfigInput> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (!isObject(parsed)) throw new CodeboneError('CONFIG_INVALID', `${label} must contain a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodeboneError('CONFIG_INVALID', `Malformed JSON in ${label}: ${error.message}`);
    throw error;
  }
}

function validateConfig(raw: ConfigInput, source: CodeboneConfig['source'], warnings: string[]): CodeboneConfig {
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) warnings.push(warning('CONFIG_UNKNOWN_KEY', `${source}:${key}`));
  }

  const config = { ...defaults, source, warnings: [] };
  if (raw.defaultBudget !== undefined) config.defaultBudget = positiveInt(raw.defaultBudget, 'defaultBudget');
  if (raw.maxBudget !== undefined) config.maxBudget = positiveInt(raw.maxBudget, 'maxBudget');
  if (raw.batchBudget !== undefined) config.batchBudget = positiveInt(raw.batchBudget, 'batchBudget');
  if (raw.maxFiles !== undefined) config.maxFiles = positiveInt(raw.maxFiles, 'maxFiles');
  if (raw.maxFileBytes !== undefined) config.maxFileBytes = positiveInt(raw.maxFileBytes, 'maxFileBytes');
  if (raw.timeoutMs !== undefined) config.timeoutMs = positiveInt(raw.timeoutMs, 'timeoutMs');
  if (raw.ignore !== undefined) config.ignore = stringArray(raw.ignore, 'ignore');
  if (raw.testPatterns !== undefined) config.testPatterns = stringArray(raw.testPatterns, 'testPatterns');
  if (raw.entrypoints !== undefined) config.entrypoints = stringArray(raw.entrypoints, 'entrypoints');
  if (raw.include !== undefined) config.include = stringArray(raw.include, 'include');
  if (raw.exclude !== undefined) config.exclude = stringArray(raw.exclude, 'exclude');
  if (raw.cache !== undefined) config.cache = cacheConfig(raw.cache);
  if (raw.security !== undefined) config.security = securityConfig(raw.security);
  if (raw.budgets !== undefined) config.budgets = budgetConfig(raw.budgets);
  if (raw.languages !== undefined) {
    if (!isObject(raw.languages)) throw new CodeboneError('CONFIG_INVALID', 'languages must be an object');
    config.languages = raw.languages as Record<string, { extensions?: string[] }>;
  }
  validateBudgetRelationships(config);
  return config;
}

function cacheConfig(value: unknown): CodeboneConfig['cache'] {
  if (!isObject(value)) throw new CodeboneError('CONFIG_INVALID', 'cache must be an object');
  return {
    enabled: value.enabled === undefined ? defaults.cache.enabled : booleanValue(value.enabled, 'cache.enabled'),
    maxFiles: value.maxFiles === undefined ? defaults.cache.maxFiles : positiveInt(value.maxFiles, 'cache.maxFiles'),
    maxBytes: value.maxBytes === undefined ? defaults.cache.maxBytes : positiveInt(value.maxBytes, 'cache.maxBytes'),
  };
}

function securityConfig(value: unknown): CodeboneConfig['security'] {
  if (!isObject(value)) throw new CodeboneError('CONFIG_INVALID', 'security must be an object');
  return {
    followSymlinks: value.followSymlinks === undefined ? defaults.security.followSymlinks : booleanValue(value.followSymlinks, 'security.followSymlinks'),
    allowOutsideRoot: value.allowOutsideRoot === undefined ? defaults.security.allowOutsideRoot : booleanValue(value.allowOutsideRoot, 'security.allowOutsideRoot'),
    redactSecrets: value.redactSecrets === undefined ? defaults.security.redactSecrets : booleanValue(value.redactSecrets, 'security.redactSecrets'),
  };
}

function budgetConfig(value: unknown): CodeboneConfig['budgets'] {
  if (!isObject(value)) throw new CodeboneError('CONFIG_INVALID', 'budgets must be an object');
  return {
    defaultToolTokens: value.defaultToolTokens === undefined ? defaults.budgets.defaultToolTokens : positiveInt(value.defaultToolTokens, 'budgets.defaultToolTokens'),
    maxReadBytes: value.maxReadBytes === undefined ? defaults.budgets.maxReadBytes : positiveInt(value.maxReadBytes, 'budgets.maxReadBytes'),
    maxFiles: value.maxFiles === undefined ? defaults.budgets.maxFiles : positiveInt(value.maxFiles, 'budgets.maxFiles'),
  };
}

function validateBudgetRelationships(config: Pick<CodeboneConfig, 'defaultBudget' | 'maxBudget' | 'batchBudget'>): void {
  if (config.defaultBudget > config.maxBudget) throw new CodeboneError('CONFIG_INVALID', 'defaultBudget must not exceed maxBudget');
  if (config.batchBudget > 250000) throw new CodeboneError('CONFIG_INVALID', 'batchBudget must not exceed 250000');
}

function positiveInt(value: unknown, key: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new CodeboneError('CONFIG_INVALID', `${key} must be a positive integer`);
  return Number(value);
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new CodeboneError('CONFIG_INVALID', `${key} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') throw new CodeboneError('CONFIG_INVALID', `${key}[${index}] must be a non-empty string`);
    return item.trim().replace(/\\/g, '/');
  });
}

function booleanValue(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new CodeboneError('CONFIG_INVALID', `${key} must be a boolean`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
