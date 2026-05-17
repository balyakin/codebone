import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../types.js';
import { WalkOptions, walkSourceFiles, walkSourceFilesDetailed } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';
import { findReferencesInSource } from './references.js';
import { CodeboneError, warning } from '../utils/errors.js';
import { loadConfig } from '../utils/config.js';

export interface SymbolsOptions {
  query: string;
  kind?: 'all' | 'definition' | 'reference' | 'export' | 'import';
  exact?: boolean;
  fuzzy?: boolean;
  useIndex?: boolean;
  limit?: number;
  offset?: number;
  includeImports?: boolean;
  walk?: WalkOptions;
}

export async function findSymbols(root: string, inputPath: string, options: SymbolsOptions) {
  const config = await loadConfig(root);
  const { limit, offset } = normalizePagination(options.limit, options.offset);
  const discovery = await walkSourceFilesDetailed(root, inputPath, { ...options.walk, maxFiles: options.walk?.maxFiles ?? config.maxFiles, maxFileBytes: options.walk?.maxFileBytes ?? config.maxFileBytes, timeoutMs: options.walk?.timeoutMs ?? config.timeoutMs });
  const files = discovery.files;
  const matches: Array<Record<string, unknown>> = [];
  const exact = options.fuzzy ? false : options.exact ?? true;
  const maxMatches = Math.max(limit + offset, limit);
  const query = options.query;
  const indexed = options.useIndex === false ? [] : await findIndexedDefinitions(root, inputPath, query, { exact, limit: maxMatches, kind: options.kind, includeImports: options.includeImports !== false, maxFiles: options.walk?.maxFiles ?? config.maxFiles });
  matches.push(...indexed);
  const scanDefinitions = indexed.length === 0;
  const warnings = [...discovery.warnings];

  for (const file of files) {
    try {
      const { text: source } = await readTextFileSafe(file.absolutePath, config.maxFileBytes, root);
      if (scanDefinitions) {
        const skeleton = await skeletonSourceAsync(root, file.relativePath, source);
        if (skeleton.warnings.length) warnings.push(warning('PARSE_FALLBACK', file.relativePath));
        for (const symbol of flattenSymbols(skeleton.symbols)) {
          const nameMatches = exact ? symbol.name === query || symbol.qualifiedName === query : symbol.qualifiedName.toLowerCase().includes(query.toLowerCase());
          const matchKind = symbol.kind === 'import' ? 'import' : 'definition';
          if (matchKind === 'import' && (options.kind === 'definition' || (options.kind !== 'import' && !options.includeImports))) continue;
          const kindMatches = options.kind === 'all' || !options.kind || options.kind === matchKind || (options.kind === 'export' && symbol.exported);
          if (nameMatches && kindMatches) {
            matches.push({
              symbolId: symbol.symbolId,
              kind: matchKind,
              exported: symbol.exported,
              file: symbol.file,
              line: symbol.startLine,
              column: symbol.startColumn,
              symbolKind: symbol.kind,
              signature: symbol.signature,
              context: symbol.signature,
              confidence: symbol.confidence,
            });
          }
        }
      }
      if (!options.kind || options.kind === 'all' || options.kind === 'reference') {
        matches.push(...(await findReferencesInSource(file.relativePath, source, query, Number.MAX_SAFE_INTEGER)).map((match) => ({ ...match, confidence: match.source === 'ast' ? 'high' : isCommentContext(String(match.context ?? '')) ? 'low' : 'medium' })));
      }
    } catch (error) {
      warnings.push(warning('PARSE_ERROR', `${file.relativePath}:${error instanceof Error ? error.message : String(error)}`));
    }
  }

  matches.sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.line ?? 0) - Number(b.line ?? 0) || String(a.context ?? '').localeCompare(String(b.context ?? '')) || String(a.kind ?? '').localeCompare(String(b.kind ?? '')) || String(a.symbolId ?? '').localeCompare(String(b.symbolId ?? '')));
  const total = matches.length;
  const paged = matches.slice(offset, offset + limit);
  const text = paged.map((match) => `${String(match.kind).toUpperCase()} ${match.file}:${match.line} ${match.context}`).join('\n');
  return { schemaVersion: SCHEMA_VERSION, query, matches: paged, limit, offset, total, hasMore: offset + paged.length < total, warnings, truncated: offset >= total ? false : discovery.truncated || offset + paged.length < total, tokenEstimate: estimateTokens(text), tokenEstimator: TOKEN_ESTIMATOR };
}

async function findIndexedDefinitions(root: string, inputPath: string, query: string, options: { exact: boolean; limit: number; kind?: SymbolsOptions['kind']; includeImports: boolean; maxFiles: number }): Promise<Array<Record<string, unknown>>> {
  if (options.kind === 'reference') return [];
  const indexRoot = path.join(root, '.codebone', 'index.v1');
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(indexRoot, 'manifest.json'), 'utf8')) as { fileMeta?: Array<{ relativePath: string; shard: string }> };
    const byName = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'by-name.json'), 'utf8')) as Record<string, string[]>;
    const byQualifiedName = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'by-qualified-name.json'), 'utf8')) as Record<string, string[]>;
    const trigrams = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'trigrams.json'), 'utf8')) as Record<string, string[]>;
    const scopedFiles = new Set((await walkSourceFiles(root, inputPath, { maxFiles: options.maxFiles })).map((file) => file.relativePath));
    const ids = options.exact
      ? [...(byName[query] ?? []), ...(byQualifiedName[query] ?? [])]
      : trigramCandidates(query, trigrams, byQualifiedName);
    const uniqueIds = [...new Set(ids)].filter((id) => scopedFiles.has(id.split('#')[0])).slice(0, options.limit);
    const shardByPath = new Map((manifest.fileMeta ?? []).map((meta) => [meta.relativePath, meta.shard]));
    const results: Array<Record<string, unknown>> = [];
    for (const symbolId of uniqueIds) {
      const file = symbolId.split('#')[0];
      const shard = shardByPath.get(file);
      if (!shard) continue;
      const data = JSON.parse(await fs.readFile(path.join(indexRoot, 'files', shard), 'utf8')) as { symbols?: Array<Record<string, unknown>> };
      const symbol = data.symbols?.find((item) => item.symbolId === symbolId);
      if (!symbol) continue;
      if (symbol.kind === 'import' && (options.kind === 'definition' || (options.kind !== 'import' && !options.includeImports))) continue;
      if (options.kind === 'import' && symbol.kind !== 'import') continue;
      if (options.kind === 'export' && !symbol.exported) continue;
      const matchKind = symbol.kind === 'import' ? 'import' : 'definition';
      results.push({ symbolId, kind: matchKind, exported: Boolean(symbol.exported), file, line: symbol.startLine, column: symbol.startColumn, symbolKind: symbol.kind, signature: symbol.signature, context: symbol.signature, confidence: symbol.confidence ?? 'medium' });
    }
    return results;
  } catch {
    return [];
  }
}

function trigramCandidates(query: string, trigrams: Record<string, string[]>, byQualifiedName: Record<string, string[]>): string[] {
  const normalized = query.toLowerCase();
  const grams = makeTrigrams(normalized);
  const candidateIds = grams.map((gram) => trigrams[gram] ?? []);
  if (candidateIds.some((ids) => ids.length === 0)) return [];
  const [first, ...rest] = candidateIds.map((ids) => new Set(ids));
  const ids = [...first].filter((id) => rest.every((set) => set.has(id)));
  const qualifiedNameById = new Map(Object.entries(byQualifiedName).flatMap(([name, values]) => values.map((id) => [id, name] as const)));
  return ids.filter((id) => qualifiedNameById.get(id)?.toLowerCase().includes(normalized));
}

function makeTrigrams(value: string): string[] {
  if (value.length <= 3) return [value];
  return Array.from(new Set(Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3))));
}

function isCommentContext(value: string): boolean {
  return /^\s*(\/\/|#|\/\*|\*)/.test(value);
}

function normalizePagination(limitValue: unknown, offsetValue: unknown): { limit: number; offset: number } {
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CodeboneError('INVALID_INPUT', 'limit must be an integer between 1 and 1000');
  if (!Number.isInteger(offset) || offset < 0) throw new CodeboneError('INVALID_INPUT', 'offset must be a non-negative integer');
  return { limit, offset };
}

export function renderSymbols(data: Awaited<ReturnType<typeof findSymbols>>): string {
  return `Found ${data.matches.length} matches for "${data.query}":\n\n${data.matches.map((match) => `  ${String(match.kind).toUpperCase().padEnd(10)} ${match.file}:${match.line}  ${match.context}`).join('\n')}`;
}
