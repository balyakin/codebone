import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../types.js';
import { walkSourceFilesDetailed } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { loadConfig } from '../utils/config.js';
import { warning } from '../utils/errors.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';
import { TOKEN_ESTIMATOR } from './budget.js';

export interface IndexedFileMeta {
  relativePath: string;
  size: number;
  mtimeMs: number;
  hash: string;
  shard: string;
}

interface FileShard {
  file: { relativePath: string; language: string; size: number; mtimeMs: number };
  hash: string;
  symbols: ReturnType<typeof flattenSymbols>;
}

export async function buildIndex(root: string, inputPath = '.', options: { clear?: boolean } = {}) {
  const config = await loadConfig(root);
  const startedAt = Date.now();
  const indexRoot = path.join(root, '.codebone', 'index.v1');
  if (options.clear) await fs.rm(indexRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(indexRoot, 'files'), { recursive: true });
  await fs.mkdir(path.join(indexRoot, 'dictionaries'), { recursive: true });
  const previous = options.clear ? undefined : await readPreviousManifest(indexRoot);
  const previousByPath = new Map((previous?.fileMeta ?? []).map((meta) => [meta.relativePath, meta]));
  const discovery = await walkSourceFilesDetailed(root, inputPath, { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, timeoutMs: config.timeoutMs });
  const files = discovery.files;
  const warnings = [...discovery.warnings];
  let truncated = discovery.truncated;
  const byName: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const byPath: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const byQualifiedName: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const imports: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const exports: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const trigrams: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let symbolCount = 0;
  const languages: Record<string, number> = {};
  const fileMeta: IndexedFileMeta[] = [];
  let reused = 0;
  let updated = 0;

  for (const file of files) {
    if (Date.now() - startedAt > config.timeoutMs) {
      truncated = true;
      warnings.push(warning('TIMEOUT', `indexing exceeded ${config.timeoutMs}ms`));
      break;
    }
    const shardName = shardNameForPath(file.relativePath);
    const previousMeta = previousByPath.get(file.relativePath);
    let shard: FileShard | undefined;
    if (previousMeta && previousMeta.size === file.size && previousMeta.mtimeMs === file.mtimeMs) {
      shard = await readShard(indexRoot, previousMeta.shard);
      if (shard) reused += 1;
    }
    if (!shard) {
      const { text: source } = await readTextFileSafe(file.absolutePath, config.maxFileBytes, root);
      const hash = crypto.createHash('sha1').update(source).digest('hex');
      if (previousMeta?.hash === hash) {
        shard = await readShard(indexRoot, previousMeta.shard);
      }
      if (!shard) {
        const skeleton = await skeletonSourceAsync(root, file.relativePath, source);
        shard = { file, hash, symbols: flattenSymbols(skeleton.symbols) };
      } else {
        shard = { ...shard, file, hash };
      }
      await fs.writeFile(path.join(indexRoot, 'files', shardName), JSON.stringify(shard, null, 2));
      updated += 1;
    }
    const symbols = shard.symbols;
    symbolCount += symbols.length;
    languages[file.language] = (languages[file.language] ?? 0) + 1;
    byPath[file.relativePath] = symbols.map((symbol) => symbol.symbolId);
    for (const symbol of symbols) {
      byName[symbol.name] ??= [];
      byName[symbol.name].push(symbol.symbolId);
      byQualifiedName[symbol.qualifiedName] ??= [];
      byQualifiedName[symbol.qualifiedName].push(symbol.symbolId);
      if (symbol.kind === 'import') {
        imports[file.relativePath] ??= [];
        imports[file.relativePath].push(symbol.source ?? symbol.signature);
      }
      if (symbol.exported) {
        exports[file.relativePath] ??= [];
        exports[file.relativePath].push(symbol.symbolId);
      }
      for (const trigram of makeTrigrams(symbol.qualifiedName)) {
        trigrams[trigram] ??= [];
        trigrams[trigram].push(symbol.symbolId);
      }
    }
    fileMeta.push({ relativePath: file.relativePath, size: file.size, mtimeMs: file.mtimeMs, hash: shard.hash, shard: shardName });
  }

  await removeStaleShards(indexRoot, new Set(fileMeta.map((meta) => meta.shard)));

  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'by-name.json'), JSON.stringify(byName, null, 2));
  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'by-path.json'), JSON.stringify(byPath, null, 2));
  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'by-qualified-name.json'), JSON.stringify(byQualifiedName, null, 2));
  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'imports.json'), JSON.stringify(imports, null, 2));
  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'exports.json'), JSON.stringify(exports, null, 2));
  await fs.writeFile(path.join(indexRoot, 'dictionaries', 'trigrams.json'), JSON.stringify(trigrams, null, 2));
  const manifest = {
    schemaVersion: 'codebone.index.v1',
    rootHash: crypto.createHash('sha1').update(root).digest('hex').slice(0, 12),
    createdAt: new Date().toISOString(),
    files: fileMeta.length,
    symbols: symbolCount,
    languages,
    fileMeta,
    incremental: { reused, updated, deleted: Math.max(0, (previous?.fileMeta.length ?? 0) - fileMeta.length) },
    dictionaries: { byName: 'dictionaries/by-name.json', byPath: 'dictionaries/by-path.json', byQualifiedName: 'dictionaries/by-qualified-name.json', imports: 'dictionaries/imports.json', exports: 'dictionaries/exports.json', trigrams: 'dictionaries/trigrams.json' },
  };
  await fs.writeFile(path.join(indexRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ...manifest, schemaVersion: SCHEMA_VERSION, indexPath: '.codebone/index.v1', warnings, truncated, tokenEstimate: 100, tokenEstimator: TOKEN_ESTIMATOR };
}

export async function indexStatus(root: string) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.codebone', 'index.v1', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    return { schemaVersion: SCHEMA_VERSION, exists: true, manifest, warnings: [], truncated: false, tokenEstimate: 100, tokenEstimator: TOKEN_ESTIMATOR };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, exists: false, manifest: null, warnings: ['index_missing'], truncated: false, tokenEstimate: 20, tokenEstimator: TOKEN_ESTIMATOR };
  }
}

export function renderIndex(data: Awaited<ReturnType<typeof buildIndex>>): string {
  return `Indexing complete\n  Scanned ${data.files} files\n  Found ${data.symbols} symbols\n  Reused ${data.incremental.reused} shards, updated ${data.incremental.updated}, deleted ${data.incremental.deleted}\n  Index saved to ${data.indexPath}\n\nLanguages: ${Object.entries(data.languages).map(([language, count]) => `${language} (${count})`).join(', ')}`;
}

async function readPreviousManifest(indexRoot: string): Promise<{ fileMeta: IndexedFileMeta[] } | undefined> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(indexRoot, 'manifest.json'), 'utf8')) as { fileMeta?: IndexedFileMeta[] };
    return { fileMeta: manifest.fileMeta ?? [] };
  } catch {
    return undefined;
  }
}

async function readShard(indexRoot: string, shard: string): Promise<FileShard | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(indexRoot, 'files', shard), 'utf8')) as FileShard;
  } catch {
    return undefined;
  }
}

async function removeStaleShards(indexRoot: string, active: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(indexRoot, 'files'));
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => entry.endsWith('.json') && !active.has(entry)).map((entry) => fs.rm(path.join(indexRoot, 'files', entry), { force: true })));
}

function shardNameForPath(relativePath: string): string {
  return `${crypto.createHash('sha1').update(relativePath).digest('hex')}.json`;
}

function makeTrigrams(value: string): string[] {
  const normalized = value.toLowerCase();
  if (normalized.length <= 3) return [normalized];
  return Array.from(new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3))));
}
