import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../types.js';
import { walkSourceFiles } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens } from './budget.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';
import { findReferencesInSource } from './references.js';

export interface SymbolsOptions {
  query: string;
  kind?: 'all' | 'definition' | 'reference' | 'export' | 'import';
  exact?: boolean;
  fuzzy?: boolean;
  useIndex?: boolean;
  limit?: number;
  includeImports?: boolean;
}

export async function findSymbols(root: string, inputPath: string, options: SymbolsOptions) {
  const files = await walkSourceFiles(root, inputPath, { maxFiles: 1000 });
  const matches: Array<Record<string, unknown>> = [];
  const exact = options.fuzzy ? false : options.exact ?? true;
  const limit = options.limit ?? 100;
  const query = options.query;
  const indexed = options.useIndex === false ? [] : await findIndexedDefinitions(root, inputPath, query, { exact, limit, kind: options.kind, includeImports: options.includeImports !== false });
  matches.push(...indexed);
  const scanDefinitions = indexed.length === 0;

  for (const file of files) {
    if (matches.length >= limit) break;
    const { text: source } = await readTextFileSafe(file.absolutePath, undefined, root);
    if (scanDefinitions) {
      const skeleton = await skeletonSourceAsync(root, file.relativePath, source);
      for (const symbol of flattenSymbols(skeleton.symbols)) {
        if (matches.length >= limit) break;
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
      matches.push(...(await findReferencesInSource(file.relativePath, source, query, limit - matches.length)).map((match) => ({ ...match, confidence: match.source === 'ast' ? 'high' : 'medium' })));
    }
  }

  const text = matches.map((match) => `${String(match.kind).toUpperCase()} ${match.file}:${match.line} ${match.context}`).join('\n');
  return { schemaVersion: SCHEMA_VERSION, query, matches, warnings: [], truncated: matches.length >= limit, tokenEstimate: estimateTokens(text) };
}

async function findIndexedDefinitions(root: string, inputPath: string, query: string, options: { exact: boolean; limit: number; kind?: SymbolsOptions['kind']; includeImports: boolean }): Promise<Array<Record<string, unknown>>> {
  if (options.kind === 'reference') return [];
  const indexRoot = path.join(root, '.codebone', 'index.v1');
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(indexRoot, 'manifest.json'), 'utf8')) as { fileMeta?: Array<{ relativePath: string; shard: string }> };
    const byName = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'by-name.json'), 'utf8')) as Record<string, string[]>;
    const byQualifiedName = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'by-qualified-name.json'), 'utf8')) as Record<string, string[]>;
    const trigrams = JSON.parse(await fs.readFile(path.join(indexRoot, 'dictionaries', 'trigrams.json'), 'utf8')) as Record<string, string[]>;
    const scopedFiles = new Set((await walkSourceFiles(root, inputPath, { maxFiles: 100000 })).map((file) => file.relativePath));
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

export function renderSymbols(data: Awaited<ReturnType<typeof findSymbols>>): string {
  return `Found ${data.matches.length} matches for "${data.query}":\n\n${data.matches.map((match) => `  ${String(match.kind).toUpperCase().padEnd(10)} ${match.file}:${match.line}  ${match.context}`).join('\n')}`;
}
