import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configureLanguageExtensions } from '../languages/registry.js';
import { resolveInsideRoot } from './paths.js';

const configSchema = z.object({
  schemaVersion: z.literal('codebone.config.v1').default('codebone.config.v1'),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  languages: z.record(z.string(), z.object({ extensions: z.array(z.string()).optional() }).passthrough()).default({}),
  security: z.object({
    followSymlinks: z.boolean().default(false),
    allowOutsideRoot: z.boolean().default(false),
    redactSecrets: z.boolean().default(true),
  }).default({}),
  budgets: z.object({
    defaultToolTokens: z.number().int().positive().default(12000),
    maxReadBytes: z.number().int().positive().default(65536),
    maxFiles: z.number().int().positive().default(200),
  }).default({}),
});

export type CodeboneConfig = z.infer<typeof configSchema>;

const defaults = configSchema.parse({});
const cache = new Map<string, Promise<CodeboneConfig>>();
const configuredPaths = new Map<string, string>();

export function setConfigPath(root: string, configPath: string | undefined): void {
  if (configPath) configuredPaths.set(root, configPath);
  cache.delete(`${root}:${configPath ?? configuredPaths.get(root) ?? '<auto>'}`);
}

export function clearConfigCache(): void {
  cache.clear();
  configuredPaths.clear();
}

export async function loadConfig(root: string, configPath?: string): Promise<CodeboneConfig> {
  const resolvedConfigPath = configPath ?? configuredPaths.get(root);
  const key = `${root}:${resolvedConfigPath ?? '<auto>'}`;
  if (!cache.has(key)) cache.set(key, readConfig(root, resolvedConfigPath));
  return cache.get(key)!;
}

export async function effectiveConfig(root: string, configPath?: string) {
  const config = await loadConfig(root, configPath);
  return { ...config, root };
}

async function readConfig(root: string, configPath?: string): Promise<CodeboneConfig> {
  const absolutePath = configPath ? resolveInsideRoot(root, configPath) : path.join(root, '.codebone.json');
  try {
    const parsed = JSON.parse(await fs.readFile(absolutePath, 'utf8')) as unknown;
    const config = configSchema.parse(parsed);
    const effective = {
      ...defaults,
      ...config,
      security: { ...defaults.security, ...config.security },
      budgets: { ...defaults.budgets, ...config.budgets },
    };
    configureLanguageExtensions(effective.languages);
    return effective;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      configureLanguageExtensions(defaults.languages);
      return defaults;
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON config: ${configPath ?? '.codebone.json'}`);
    if (error instanceof z.ZodError) throw new Error(`Invalid codebone config: ${error.issues.map((issue) => issue.message).join(', ')}`);
    throw error;
  }
}
