import path from 'node:path';
import { SCHEMA_VERSION } from '../types.js';
import { WalkOptions, walkSourceFilesDetailed } from '../utils/file-walker.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';
import { resolveImport, summarizeGraph } from './graph.js';
import { readTextFileSafe } from '../utils/security.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';
import { CodeboneError } from '../utils/errors.js';
import { loadConfig } from '../utils/config.js';

export interface MapOptions extends WalkOptions {
  budget?: number;
  limit?: number;
  offset?: number;
}

export async function projectMap(root: string, inputPath = '.', options: number | MapOptions = 1200) {
  const config = await loadConfig(root);
  const mapOptions = typeof options === 'number' ? { budget: options } : options;
  const { limit, offset } = normalizePagination(mapOptions.limit, mapOptions.offset);
  const discovery = await walkSourceFilesDetailed(root, inputPath, mapOptions);
  const files = discovery.files;
  const languages: Record<string, number> = {};
  const directories = new Map<string, { files: number; symbols: number }>();
  const fileSet = new Set(files.map((file) => file.relativePath));
  const edges: Array<{ from: string; source: string; resolved?: string }> = [];
  const exports: Array<{ file: string; name: string; kind: string }> = [];
  for (const file of files) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
    const dir = path.posix.dirname(file.relativePath).split('/').slice(0, 2).join('/');
    const dirPath = dir === '.' ? '/' : dir;
    const current = directories.get(dirPath) ?? { files: 0, symbols: 0 };
    let symbolCount = 0;
    try {
      const { text: source } = await readTextFileSafe(file.absolutePath, config.maxFileBytes, root);
      const symbols = flattenSymbols((await skeletonSourceAsync(root, file.relativePath, source)).symbols);
      symbolCount = symbols.filter((symbol) => symbol.kind !== 'import').length;
      for (const symbol of symbols) {
        if (symbol.kind === 'import' && symbol.source) edges.push({ from: file.relativePath, source: symbol.source, resolved: resolveImport(file.relativePath, symbol.source, fileSet) });
        if (symbol.exported) exports.push({ file: file.relativePath, name: symbol.qualifiedName, kind: symbol.kind });
      }
    } catch {
      symbolCount = 0;
    }
    directories.set(dirPath, { files: current.files + 1, symbols: current.symbols + symbolCount });
  }
  const entrypoints = files
    .map((file) => file.relativePath)
    .filter((file) => /(^|\/)(index|main|server|cli|app|mcp-server)\.[^.]+$/.test(file))
    .slice(0, 20);
  const allDirectories = [...directories.entries()].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0])).map(([dirPath, counts]) => ({ path: dirPath, files: counts.files, symbols: counts.symbols }));
  const topDirectories = allDirectories.slice(offset, offset + limit);
  const suggestedReads = [
    ...(entrypoints[0] ? [{ command: 'skeleton', path: entrypoints[0] }] : []),
    { command: 'skeleton', path: inputPath },
    { command: 'context', goal: 'understand project structure', budget: Math.max(4000, (mapOptions.budget ?? 1200) * 4) },
  ];
  const graph = summarizeGraph(edges, exports, fileSet);
  const suggestedNextReads = suggestedReads.map((item, index) => ({
    tool: `codebone_${item.command}` as 'codebone_skeleton' | 'codebone_context',
    args: 'path' in item ? { path: item.path } : { goal: item.goal ?? 'understand project structure', budget: item.budget },
    reason: index === 0 ? 'inspect the primary entrypoint' : item.command === 'skeleton' ? 'inspect directory structure' : 'build a broader context pack',
    priority: index === 0 ? 'high' : 'medium',
  }));
  const pagePastEnd = offset >= allDirectories.length;
  const data = {
    schemaVersion: SCHEMA_VERSION,
    languages,
    files: { indexed: files.length, ignored: discovery.stats.skipped, unsupported: discovery.stats.unsupported },
    entrypoints,
    topDirectories,
    limit,
    offset,
    total: allDirectories.length,
    hasMore: offset + topDirectories.length < allDirectories.length,
    graph: graph.summary,
    suggestedReads,
    suggestedNextReads,
    warnings: discovery.warnings,
    truncated: pagePastEnd ? false : discovery.truncated,
  };
  return { ...data, tokenEstimate: estimateTokens(JSON.stringify(data)), tokenEstimator: TOKEN_ESTIMATOR };
}

function normalizePagination(limitValue: unknown, offsetValue: unknown): { limit: number; offset: number } {
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CodeboneError('INVALID_INPUT', 'limit must be an integer between 1 and 1000');
  if (!Number.isInteger(offset) || offset < 0) throw new CodeboneError('INVALID_INPUT', 'offset must be a non-negative integer');
  return { limit, offset };
}

export function renderMap(data: Awaited<ReturnType<typeof projectMap>>): string {
  const langs = Object.entries(data.languages).map(([language, count]) => `${language} ${count}`).join(', ') || 'none';
  return `Project: .\nLanguages: ${langs}\nFiles: ${data.files.indexed} indexed, ${data.files.ignored} ignored, ${data.files.unsupported} unsupported\nGraph: ${data.graph.imports} imports (${data.graph.resolvedImports} resolved), ${data.graph.exports} exports\n\nEntrypoints:\n${data.entrypoints.map((item) => `  ${item}`).join('\n')}\n\nSuggested first reads:\n${data.suggestedReads.map((item) => `  codebone ${item.command} ${'path' in item ? item.path : ''}`).join('\n')}`;
}
