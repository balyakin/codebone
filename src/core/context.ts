import path from 'node:path';
import { CodeSymbol, SCHEMA_VERSION } from '../types.js';
import { walkSourceFilesDetailed } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { CodeboneError, warning } from '../utils/errors.js';
import { loadConfig } from '../utils/config.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';
import { resolveImport, summarizeGraph } from './graph.js';
import { readCode } from './reader.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

export interface ContextOptions {
  goal: string;
  goals?: string[];
  symbols?: string[];
  path?: string;
  budget?: number;
  includeTests?: boolean;
  changedOnly?: boolean;
  mode?: 'full' | 'architecture' | 'overview' | 'edit_prep' | 'composition' | 'test_impact';
  productionOnly?: boolean;
  testsOnly?: boolean;
  includeMocks?: boolean;
  includeConfig?: boolean;
  includeMigrations?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
  ignore?: string[];
}

export async function buildContext(root: string, options: ContextOptions) {
  const config = await loadConfig(root);
  const budget = options.budget ?? config.defaultBudget;
  validateBudget(budget, config.maxBudget);
  const maxFiles = options.maxFiles ?? config.maxFiles;
  const maxFileBytes = options.maxFileBytes ?? config.maxFileBytes;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const warnings: string[] = [];
  const goals = normalizeGoals([...(options.goals ?? []), options.goal]);
  const goal = goals.join(' | ');
  const requestedSymbols = normalizeRequestedSymbols(options.symbols ?? []);
  const terms = parseGoalTerms(goals, config.entrypoints);
  const changedFiles = new Set<string>();
  const omittedFiles = [] as Array<{ path: string; reason: string }>;
  let analysisTimedOut = false;
  const analysisStartedAt = Date.now();
  if (options.changedOnly) warnings.push('IMPORT_RESOLUTION_LIMITED:changedOnly is disabled in runtime because codebone does not shell out to git');
  const discovery = await walkSourceFilesDetailed(root, options.path ?? '.', { maxFiles, maxFileBytes, timeoutMs, ignore: options.ignore });
  warnings.push(...config.warnings, ...discovery.warnings);
  omittedFiles.push(...discovery.skippedFiles.filter((item) => item.reason === 'file_too_large').slice(0, 50));
  for (const skipped of discovery.skippedFiles.filter((item) => item.reason === 'file_too_large').slice(0, 10)) warnings.push(warning('TRUNCATED', `${skipped.path}:file_too_large`));
  const files = discovery.files
    .filter((file) => includeByContextFilters(file.relativePath, options));
  const ranked = [] as Array<{ path: string; score: number; reason: string; tokens: number; content: string; symbolId?: string }>;
  const fileRecords = [] as Array<{ path: string; language: string; source: string; imports: string[]; exported: Array<{ name: string; kind: string }>; symbols: ReturnType<typeof flattenSymbols>; symbolText: string; tokens: number; size: number; content: string; symbolId?: string }>;
  for (const file of files) {
    if (Date.now() - analysisStartedAt > timeoutMs) {
      analysisTimedOut = true;
      warnings.push(warning('TIMEOUT', `context analysis exceeded ${timeoutMs}ms`));
      break;
    }
    if (options.includeTests === false && isTestPath(file.relativePath)) {
      omittedFiles.push({ path: file.relativePath, reason: 'includeTests:false' });
      continue;
    }
    try {
      const { text: source } = await readTextFileSafe(file.absolutePath, maxFileBytes, root);
      const structuralMode = options.mode === 'architecture' || options.mode === 'overview' || options.mode === 'edit_prep' || options.mode === 'composition' || options.mode === 'test_impact';
      const skeleton = await skeletonSourceAsync(root, file.relativePath, source, { budget: structuralMode ? undefined : Math.min(2000, budget) });
      if (skeleton.warnings.length) warnings.push(warning('PARSE_FALLBACK', file.relativePath));
      const symbols = flattenSymbols(skeleton.symbols);
      const content = JSON.stringify(skeleton, null, 2);
      fileRecords.push({ path: file.relativePath, language: file.language, source, imports: symbols.filter((symbol) => symbol.kind === 'import').map((symbol) => symbol.source ?? symbol.signature), exported: symbols.filter((symbol) => symbol.exported).map((symbol) => ({ name: symbol.qualifiedName, kind: symbol.kind })), symbols, symbolText: symbols.map((symbol) => `${symbol.name} ${symbol.signature}`).join('\n'), tokens: skeleton.tokenEstimate, size: file.size, content, symbolId: symbols.find((symbol) => symbol.kind !== 'import')?.symbolId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /File too large/i.test(message) ? 'file_too_large' : /Binary/i.test(message) ? 'unsupported_binary' : `parse_or_read_error:${message}`;
      omittedFiles.push({ path: file.relativePath, reason });
      warnings.push(warning('PARSE_ERROR', `${file.relativePath}:${reason}`));
    }
  }
  const requestedMatches = requestedSymbols.length
    ? matchRequestedSymbols(fileRecords, requestedSymbols)
    : undefined;
  if (requestedMatches && requestedMatches.found.size === 0) throw new CodeboneError('SYMBOL_NOT_FOUND', `None of the requested symbols were found: ${requestedSymbols.join(', ')}`);
  if (requestedMatches && requestedMatches.missing.length) warnings.push(warning('SYMBOL_NOT_FOUND', requestedMatches.missing.join(', ')));
  const fileSet = new Set(fileRecords.map((record) => record.path));
  const graph = summarizeGraph(
    fileRecords.flatMap((record) => record.imports.map((source) => ({ from: record.path, source, resolved: resolveImport(record.path, source, fileSet) }))),
    fileRecords.flatMap((record) => record.exported.map((entry) => ({ file: record.path, ...entry }))),
    fileSet,
  );
  const goalMatchedFiles = new Set<string>();
  for (const record of fileRecords) {
    const haystack = `${record.path}\n${record.symbolText}`.toLowerCase();
    if (terms.some((term) => haystack.includes(term))) goalMatchedFiles.add(record.path);
  }
  for (const record of fileRecords) {
    const haystack = `${record.path}\n${record.symbolText}\n${record.imports.join('\n')}`.toLowerCase();
    let score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) / Math.max(1, terms.length);
    const reasons: string[] = [];
    if (score > 0) reasons.push('goal terms match path, symbols, or imports');
    if (requestedMatches?.byFile.has(record.path)) {
      score += 2;
      reasons.push('requested symbol match');
    }
    if (/(^|\/)(index|main|server|cli|app|mcp-server)\.[^.]+$/.test(record.path)) {
      score += 0.35;
      reasons.push('entrypoint');
    }
    if (changedFiles.has(record.path)) {
      score += 0.35;
      reasons.push('changed file');
    }
    if (graph.edges.some((edge) => edge.from === record.path && edge.resolved && goalMatchedFiles.has(edge.resolved))) {
      score += 0.25;
      reasons.push('imports matched file');
    }
    if (graph.edges.some((edge) => edge.resolved === record.path && goalMatchedFiles.has(edge.from))) {
      score += 0.25;
      reasons.push('imported by matched file');
    }
    if (isRelatedTest(record.path, goalMatchedFiles)) {
      score += 0.3;
      reasons.push('related test proximity');
    } else if (/(test|spec)/.test(record.path)) {
      score += 0.1;
      reasons.push('test file');
    }
    if (record.size > 250_000) {
      score -= 0.3;
      reasons.push('large file penalty');
    }
    if (isGeneratedOrVendor(record.path)) {
      score -= 0.35;
      reasons.push('generated/vendor penalty');
    }
    if (score > 0 || requestedMatches?.byFile.has(record.path)) ranked.push({ path: record.path, score, reason: reasons.join(', ') || 'structural match', tokens: record.tokens, content: record.content, symbolId: requestedMatches?.byFile.get(record.path)?.[0]?.symbolId ?? record.symbolId });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (requestedMatches) {
    const requestedPaths = new Set(requestedMatches.byFile.keys());
    const narrowed = ranked.filter((item) => requestedPaths.has(item.path));
    ranked.length = 0;
    ranked.push(...narrowed);
  }
  const items = [] as Array<{ type: 'skeleton' | 'symbol_body'; path: string; score: number; reason: string; content: string; symbolId?: string }>;
  let usedTokens = 0;
  const testRelations = inferTestRelations(fileRecords, graph.edges).slice(0, 30);
  if (options.mode === 'architecture' || options.mode === 'overview' || options.mode === 'edit_prep' || options.mode === 'composition' || options.mode === 'test_impact') {
    const architecture = buildArchitectureSummary(fileRecords, graph.edges, testRelations, changedFiles);
    const content = options.mode === 'overview'
      ? renderOverviewSummary(architecture)
      : options.mode === 'edit_prep'
        ? renderEditPrepSummary(architecture, goal)
        : options.mode === 'composition'
          ? renderCompositionSummary(architecture, budget)
          : options.mode === 'test_impact'
            ? renderTestImpactSummary(architecture, goal)
          : renderArchitectureSummary(architecture, budget);
    const omitted = omittedFiles.slice(0, 20);
    const contextFiles = contextFilesFromRecords(fileRecords, requestedMatches?.byFile, ranked, budget);
    const suggestedNextReads = suggestedReadsFromRanked(ranked, contextFiles);
    const architectureTokenEstimate = estimateTokens(content + JSON.stringify(contextFiles) + JSON.stringify(suggestedNextReads));
    const architectureTruncated = omitted.length > 0 || estimateTokens(renderArchitectureSummary(architecture, 1_000_000)) > budget || discovery.truncated || analysisTimedOut;
    if (architectureTokenEstimate > budget) warnings.push(warning('BUDGET_TOO_SMALL', 'minimal architecture context exceeds budget'));
    const data = { schemaVersion: SCHEMA_VERSION, goal, goals, requestedSymbols, root, mode: options.mode, budget, usedTokens: estimateTokens(content), items: [{ type: `${options.mode}_summary` as const, path: options.path ?? '.', score: 1, reason: `compact ${options.mode} summary`, content }], files: contextFiles, suggestedNextReads, omitted, nextReads: suggestedNextReads.map(toLegacyNextRead), strategy: { queryTerms: terms, selectedFiles: contextFiles.length, selectedSymbols: contextFiles.reduce((sum, file) => sum + file.symbols.length, 0), fallbackUsed: ranked.length === 0, ignoredFiles: discovery.stats.skipped, parseErrors: warnings.filter((item) => item.startsWith('PARSE_ERROR')).length }, architecture, testRelations, warnings, truncated: architectureTruncated || architectureTokenEstimate > budget, tokenEstimate: architectureTokenEstimate, tokenEstimator: TOKEN_ESTIMATOR };
    return data;
  }
  for (const item of ranked) {
    if (usedTokens + item.tokens > budget) break;
    items.push({ type: 'skeleton', path: item.path, score: Number(item.score.toFixed(2)), reason: item.reason, content: item.content });
    usedTokens += item.tokens;
  }
  for (const item of ranked.filter((rankedItem) => rankedItem.symbolId)) {
    if (usedTokens >= budget) break;
    try {
      const body = await readCode(root, item.path, { symbolId: item.symbolId, maxBytes: Math.min(12000, (budget - usedTokens) * 4) });
      if (usedTokens + body.tokenEstimate > budget) continue;
      items.push({ type: 'symbol_body', path: item.path, symbolId: item.symbolId, score: Number(item.score.toFixed(2)), reason: 'top ranked symbol body within remaining budget', content: body.content });
      usedTokens += body.tokenEstimate;
    } catch (error) {
      warnings.push(`body_read_unavailable:${item.path}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const nextReads = ranked.slice(0, 5).map((item) => ({ command: item.symbolId ? 'read' : 'skeleton', path: item.path, symbolId: item.symbolId }));
  const included = new Set(items.map((item) => `${item.type}:${item.path}:${item.symbolId ?? ''}`));
  const omitted = [...ranked.filter((item) => !included.has(`skeleton:${item.path}:`)).slice(0, 20).map((item) => ({ path: item.path, reason: 'budget' })), ...omittedFiles.slice(0, 20)];
  let contextFiles = contextFilesFromRecords(fileRecords, requestedMatches?.byFile, ranked, budget);
  const suggestedNextReads = suggestedReadsFromRanked(ranked, contextFiles);
  const fit = fitContextPayload({ schemaVersion: SCHEMA_VERSION, goal, goals, requestedSymbols, root, budget, files: contextFiles, suggestedNextReads }, budget);
  contextFiles = fit.files;
  const legacyItems = fitLegacyItems(items, Math.max(1000, budget - estimateTokens(JSON.stringify(contextFiles)) - estimateTokens(JSON.stringify(suggestedNextReads))));
  if (fit.truncated) warnings.push(warning('TRUNCATED', 'context files/symbols/snippets were reduced to fit budget'));
  if (legacyItems.truncated) warnings.push(warning('TRUNCATED', 'legacy context items were reduced to fit budget'));
  const tokenEstimate = estimateTokens(JSON.stringify(contextFiles) + JSON.stringify(suggestedNextReads) + JSON.stringify(legacyItems.items));
  if (tokenEstimate > budget) warnings.push(warning('BUDGET_TOO_SMALL', 'minimal context envelope exceeds budget'));
  const data = { schemaVersion: SCHEMA_VERSION, goal, goals, requestedSymbols, root, mode: 'full' as const, budget, usedTokens: legacyItems.tokenEstimate, items: legacyItems.items, files: contextFiles, suggestedNextReads, omitted, nextReads: suggestedNextReads.map(toLegacyNextRead), strategy: { queryTerms: terms, selectedFiles: contextFiles.length, selectedSymbols: contextFiles.reduce((sum, file) => sum + file.symbols.length, 0), fallbackUsed: ranked.length === 0, ignoredFiles: discovery.stats.skipped, parseErrors: warnings.filter((item) => item.startsWith('PARSE_ERROR')).length }, testRelations, warnings, truncated: omitted.length > 0 || fit.truncated || legacyItems.truncated || discovery.truncated || analysisTimedOut || tokenEstimate > budget, tokenEstimate, tokenEstimator: TOKEN_ESTIMATOR };
  return data;
}

function isRelatedTest(filePath: string, matchedFiles: Set<string>): boolean {
  if (!/(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(filePath)) return false;
  const normalized = filePath.toLowerCase();
  for (const matched of matchedFiles) {
    const base = path.posix.basename(matched).replace(/\.[^.]+$/, '').toLowerCase();
    const dir = path.posix.dirname(matched).toLowerCase();
    if (normalized.includes(base) || normalized.includes(dir)) return true;
  }
  return false;
}

type ContextFile = {
  path: string;
  language: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  tokenEstimate: number;
  symbols: Array<{
    id: string;
    name: string;
    kind: string;
    range: { startLine: number; endLine: number };
    reason: string;
    snippet?: string;
    docs?: string;
  }>;
};

function validateBudget(budget: number, maxBudget: number): void {
  if (!Number.isInteger(budget) || budget < 1000 || budget > maxBudget) {
    throw new CodeboneError('INVALID_INPUT', `budget must be an integer between 1000 and ${maxBudget}`);
  }
}

function normalizeGoals(values: string[]): string[] {
  const seen = new Set<string>();
  const goals: string[] = [];
  for (const value of values) {
    const goal = value.trim();
    if (!goal || seen.has(goal)) continue;
    seen.add(goal);
    goals.push(goal);
  }
  return goals.length ? goals : ['understand project'];
}

function normalizeRequestedSymbols(values: string[]): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const value of values.flatMap((item) => item.split(','))) {
    const symbol = value.trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

function parseGoalTerms(goals: string[], entrypoints: string[]): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'about', 'understand', 'change', 'edit', 'implementation', 'server', 'code', 'task']);
  const terms = new Set<string>();
  for (const raw of [...goals, ...entrypoints]) {
    for (const token of raw.split(/[^A-Za-z0-9_./-]+/)) {
      const trimmed = token.trim();
      if (trimmed.length < 3) continue;
      for (const part of splitIdentifier(trimmed)) {
        const lower = part.toLowerCase();
        if (lower.length > 2 && !stop.has(lower)) terms.add(lower);
      }
    }
  }
  return [...terms].sort();
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_./-]+/)
    .filter(Boolean);
}

function matchRequestedSymbols(fileRecords: Array<{ path: string; symbols: CodeSymbol[] }>, requestedSymbols: string[]) {
  const byFile = new Map<string, CodeSymbol[]>();
  const found = new Set<string>();
  for (const record of fileRecords) {
    const matches = record.symbols.filter((symbol) => requestedSymbols.some((requested) => symbol.name === requested || symbol.qualifiedName === requested));
    if (matches.length) {
      byFile.set(record.path, matches.sort(compareSymbols));
      for (const match of matches) {
        for (const requested of requestedSymbols) {
          if (match.name === requested || match.qualifiedName === requested) found.add(requested);
        }
      }
    }
  }
  return { byFile, found, missing: requestedSymbols.filter((symbol) => !found.has(symbol)) };
}

function contextFilesFromRecords(
  fileRecords: Array<{ path: string; language: string; source: string; symbols: CodeSymbol[] }>,
  requestedByFile: Map<string, CodeSymbol[]> | undefined,
  ranked: Array<{ path: string; reason: string }>,
  budget: number,
): ContextFile[] {
  const rankReason = new Map(ranked.map((item) => [item.path, item.reason]));
  const selectedPaths = new Set(requestedByFile ? [...requestedByFile.keys()] : ranked.slice(0, 20).map((item) => item.path));
  if (!selectedPaths.size) for (const item of fileRecords.slice(0, 5)) selectedPaths.add(item.path);
  return fileRecords
    .filter((record) => selectedPaths.has(record.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((record) => {
      const selectedSymbols = (requestedByFile?.get(record.path) ?? record.symbols.filter((symbol) => symbol.kind !== 'import').slice(0, 8)).sort(compareSymbols);
      const symbols = selectedSymbols.map((symbol) => {
        const snippet = snippetForSymbol(record.source, symbol, Math.max(400, Math.min(1600, budget * 2)));
        return {
          id: symbol.symbolId,
          name: symbol.qualifiedName,
          kind: symbol.kind,
          range: { startLine: symbol.startLine, endLine: symbol.endLine },
          reason: requestedByFile?.get(record.path)?.some((item) => item.symbolId === symbol.symbolId) ? 'requested symbol' : 'ranked symbol',
          snippet,
          docs: docsForSymbol(record.source, symbol),
        };
      });
      const tokenEstimate = estimateTokens(JSON.stringify(symbols));
      return { path: record.path, language: record.language, confidence: confidenceForLanguage(record.language), reason: rankReason.get(record.path) ?? 'fallback file', tokenEstimate, symbols };
    });
}

function fitContextPayload(payload: { files: ContextFile[]; suggestedNextReads: Array<Record<string, unknown>> } & Record<string, unknown>, budget: number): { files: ContextFile[]; truncated: boolean } {
  let files = payload.files;
  let truncated = false;
  if (estimateTokens(JSON.stringify({ ...payload, files })) <= budget) return { files, truncated };

  files = files.map((file) => ({ ...file, symbols: file.symbols.map((symbol) => ({ ...symbol, snippet: symbol.snippet ? symbol.snippet.slice(0, 800) : undefined })) }));
  truncated = true;
  if (estimateTokens(JSON.stringify({ ...payload, files })) <= budget) return { files, truncated };

  files = files.map((file) => ({ ...file, symbols: file.symbols.map((symbol) => ({ ...symbol, snippet: undefined })) }));
  if (estimateTokens(JSON.stringify({ ...payload, files })) <= budget) return { files, truncated };

  files = files.map((file) => ({ ...file, symbols: file.symbols.slice(0, 3) })).filter((file) => file.symbols.length > 0);
  while (files.length > 1 && estimateTokens(JSON.stringify({ ...payload, files })) > budget) files = files.slice(0, -1);
  return { files, truncated };
}

function fitLegacyItems<T extends { content: string }>(items: T[], budget: number): { items: T[]; truncated: boolean; tokenEstimate: number } {
  const kept: T[] = [];
  let truncated = false;
  for (const item of items) {
    const compact = { ...item, content: item.content.length > 1200 ? `${item.content.slice(0, 1200)}\n[truncated]` : item.content };
    const next = [...kept, compact];
    if (kept.length > 0 && estimateTokens(JSON.stringify(next)) > budget) {
      truncated = true;
      break;
    }
    kept.push(compact);
  }
  if (kept.length < items.length) truncated = true;
  return { items: kept, truncated, tokenEstimate: estimateTokens(JSON.stringify(kept)) };
}

function suggestedReadsFromRanked(ranked: Array<{ path: string; reason: string; symbolId?: string }>, contextFiles: ContextFile[]) {
  const byPath = new Map(contextFiles.map((file) => [file.path, file]));
  return ranked.slice(0, 8).map((item, index) => {
    const file = byPath.get(item.path);
    const firstSymbol = file?.symbols[0];
    if (firstSymbol) {
      return { tool: 'codebone_read' as const, args: { path: item.path, symbolId: firstSymbol.id }, reason: item.reason || 'read selected symbol body', priority: index < 2 ? 'high' as const : 'medium' as const };
    }
    return { tool: 'codebone_skeleton' as const, args: { path: item.path }, reason: item.reason || 'inspect file skeleton', priority: index < 2 ? 'high' as const : 'medium' as const };
  }).slice(0, 5).sort(compareSuggestions);
}

function toLegacyNextRead(item: { tool: string; args: Record<string, unknown> }) {
  return { command: item.tool.replace(/^codebone_/, ''), path: item.args.path, symbolId: item.args.symbolId };
}

function snippetForSymbol(source: string, symbol: CodeSymbol, maxChars: number): string {
  const lines = source.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine);
  const snippet = lines.join('\n');
  return snippet.length > maxChars ? `${snippet.slice(0, maxChars)}\n[truncated]` : snippet;
}

function docsForSymbol(source: string, symbol: CodeSymbol): string | undefined {
  const lines = source.split(/\r?\n/);
  const docs: string[] = [];
  for (let index = symbol.startLine - 2; index >= 0 && docs.length < 6; index -= 1) {
    const trimmed = lines[index]?.trim() ?? '';
    if (/^(\/\/\/?|#|\/\*\*?|\*|"""|''')/.test(trimmed)) docs.unshift(trimmed);
    else if (trimmed === '') continue;
    else break;
  }
  return docs.length ? docs.join('\n') : undefined;
}

function confidenceForLanguage(language: string): 'high' | 'medium' | 'low' {
  if (['typescript', 'python', 'go', 'rust'].includes(language)) return 'high';
  if (language === 'unknown') return 'low';
  return 'medium';
}

function compareSymbols(a: CodeSymbol, b: CodeSymbol): number {
  return a.file.localeCompare(b.file) || a.startLine - b.startLine || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function compareSuggestions(a: { priority: string; tool: string; args: Record<string, unknown> }, b: { priority: string; tool: string; args: Record<string, unknown> }): number {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || a.tool.localeCompare(b.tool) || JSON.stringify(a.args).localeCompare(JSON.stringify(b.args));
}

function isGeneratedOrVendor(filePath: string): boolean {
  return /(^|\/)(vendor|vendors|third_party|node_modules|dist|build|coverage)(\/|$)|(^|\/)[^/]+\.(min|generated|gen)\.[^.]+$|(^|\/)[^/]+_(pb|generated)\.[^.]+$/.test(filePath);
}

function includeByContextFilters(filePath: string, options: ContextOptions): boolean {
  const test = isTestPath(filePath);
  const mock = /(^|\/)(mocks?|fixtures?|fakes?)(\/|$)|(^|\/)(mock_|fake_)/i.test(filePath);
  const config = /(^|\/)(config|settings)(\/|$)|\.(ya?ml|toml|ini|env|json)$/i.test(filePath);
  const migration = /(^|\/)(migrations?|alembic)(\/|$)/i.test(filePath);
  if (options.productionOnly && test) return false;
  if (options.testsOnly && !test) return false;
  if (mock && options.includeMocks === false) return false;
  if (config && options.includeConfig === false) return false;
  if (migration && options.includeMigrations === false) return false;
  return true;
}

function inferTestRelations(fileRecords: Array<{ path: string; imports: string[]; source: string; symbols: ReturnType<typeof flattenSymbols> }>, edges: Array<{ from: string; resolved?: string }>) {
  const sourceFiles = new Set(fileRecords.map((record) => record.path).filter((filePath) => !isTestPath(filePath) && !isInitFile(filePath)));
  const relations: Array<{ test: string; source: string; reason: string }> = [];
  const recordsByPath = new Map(fileRecords.map((record) => [record.path, record]));
  for (const test of fileRecords.filter((record) => isTestPath(record.path) && !isInitFile(record.path))) {
    for (const edge of edges.filter((item) => item.from === test.path && item.resolved && sourceFiles.has(item.resolved))) {
      relations.push({ test: test.path, source: edge.resolved!, reason: 'import' });
    }
    const testBase = path.posix.basename(test.path).replace(/^(test_|spec_)/, '').replace(/(_test|\.test|\.spec)?\.[^.]+$/, '').toLowerCase();
    for (const source of sourceFiles) {
      const sourceRecord = recordsByPath.get(source);
      const sourceBase = path.posix.basename(source).replace(/\.[^.]+$/, '').toLowerCase();
      if (testBase && sourceBase && (testBase === sourceBase || testBase.includes(sourceBase) || sourceBase.includes(testBase))) relations.push({ test: test.path, source, reason: 'name_proximity' });
      const exportedNames = (sourceRecord?.symbols ?? []).filter((symbol) => symbol.kind !== 'import' && !symbol.name.startsWith('_')).map((symbol) => symbol.name).filter((name) => name.length > 3);
      if (exportedNames.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(test.source))) relations.push({ test: test.path, source, reason: 'symbol_mention' });
    }
  }
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.test}:${relation.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\.|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$/.test(filePath);
}

function isInitFile(filePath: string): boolean {
  return /(^|\/)__init__\.py$/.test(filePath);
}

function buildArchitectureSummary(fileRecords: Array<{ path: string; imports: string[]; symbols: ReturnType<typeof flattenSymbols> }>, edges: Array<{ from: string; source: string; resolved?: string }>, testRelations: Array<{ test: string; source: string; reason: string }>, changedFiles: Set<string>) {
  const files = fileRecords.map((record) => ({
    path: record.path,
    classes: record.symbols.filter((symbol) => symbol.kind === 'class').map((symbol) => symbol.qualifiedName),
    functions: record.symbols.filter((symbol) => symbol.kind === 'function' && !symbol.name.startsWith('_')).map((symbol) => symbol.qualifiedName),
    rpcMethods: record.symbols.filter((symbol) => ['function', 'method'].includes(symbol.kind) && symbol.name.startsWith('rpc_')).map((symbol) => symbol.qualifiedName),
  })).filter((file) => file.classes.length || file.functions.length || file.rpcMethods.length);

  const routes = fileRecords.flatMap((record) => record.symbols.filter((symbol) => symbol.kind === 'route').map((route) => {
    const handler = record.symbols
      .filter((symbol) => ['function', 'method'].includes(symbol.kind) && symbol.startLine > route.startLine)
      .sort((a, b) => a.startLine - b.startLine)[0];
    return { file: record.path, route: route.name, line: route.startLine, handler: route.source ?? handler?.qualifiedName };
  }));

  const dependencies = buildAppDependencyGraph(fileRecords);
  const tables = uniqueBy(fileRecords.flatMap((record) => record.symbols.filter((symbol) => symbol.kind === 'table').map((symbol) => ({ file: record.path, name: symbol.name, line: symbol.startLine }))), (item) => `${item.file}:${item.name}`);
  const localImports = edges.filter((edge) => edge.resolved).map((edge) => ({ from: edge.from, to: edge.resolved!, source: edge.source }));
  const serviceEdges = localImports.filter((edge) => /service|api|route|handler|view|dao|task|worker|creator/i.test(`${edge.from} ${edge.to} ${edge.source}`));
  const rpc = buildRpcSummary(fileRecords, dependencies);
  const changed = [...changedFiles].filter((filePath) => fileRecords.some((record) => record.path === filePath)).map((filePath) => ({ path: filePath, tests: testRelations.filter((relation) => relation.source === filePath).map((relation) => relation.test) }));
  const layers = summarizeLayers(fileRecords);
  return { files, routes, rpc, dependencies, tables, serviceEdges: serviceEdges.slice(0, 20), testRelations, changed, layers };
}

function renderArchitectureSummary(summary: ReturnType<typeof buildArchitectureSummary>, budget = 8000): string {
  const sections: string[] = ['Architecture summary'];
  if (summary.routes.length) sections.push(`Routes -> handlers:\n${summary.routes.slice(0, 30).map((item) => `  ${item.route} -> ${item.handler ?? 'unknown'} (${item.file}:${item.line})`).join('\n')}`);
  if (summary.rpc.length) sections.push(`RPC summary:\n${summary.rpc.slice(0, 40).map((item) => `  ${item.name} (${item.file}:${item.line})${item.dependencies.length ? ` uses app[${item.dependencies.map((key) => `"${key}"`).join(', ')}]` : ''}`).join('\n')}`);
  if (summary.dependencies.length) sections.push(`App dependency graph:\n${summary.dependencies.map((item) => {
    const writes = item.writes.length ? ` created: ${item.writes.map((usage) => `${usage.file}:${usage.line}${usage.value ? ` = ${usage.value}` : ''}`).join(', ')}` : '';
    const reads = item.reads.length ? ` read: ${item.reads.slice(0, 6).map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : '';
    const starts = item.starts.length ? ` start: ${item.starts.map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : '';
    const stops = item.stops.length ? ` stop: ${item.stops.map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : '';
    const risk = item.starts.length && !item.stops.length ? ' [risk: started but no stop found]' : '';
    return `  app["${item.key}"]${writes}${reads}${starts}${stops}${risk}`;
  }).join('\n')}`);
  if (summary.tables.length) sections.push(`SQLAlchemy tables:\n${summary.tables.map((item) => `  ${item.name} (${item.file}:${item.line})`).join('\n')}`);
  if (summary.changed.length) sections.push(`Changed files impact:\n${summary.changed.map((item) => `  ${item.path}${item.tests.length ? ` -> tests: ${item.tests.join(', ')}` : ''}`).join('\n')}`);
  if (summary.serviceEdges.length) sections.push(`Local dependency flow:\n${summary.serviceEdges.map((item) => `  ${item.from} -> ${item.to}`).join('\n')}`);
  if (summary.files.length) sections.push(`Key files:\n${summary.files.slice(0, 30).map((item) => {
    const parts = [
      item.classes.length ? `classes: ${item.classes.slice(0, 6).join(', ')}` : '',
      item.rpcMethods.length ? `rpc: ${item.rpcMethods.slice(0, 6).join(', ')}` : '',
      item.functions.length ? `functions: ${item.functions.slice(0, 6).join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return `  ${item.path}${parts ? ` - ${parts}` : ''}`;
  }).join('\n')}`);
  if (summary.testRelations.length) sections.push(`Suggested tests:\n${summary.testRelations.slice(0, 15).map((item) => `  ${item.source} -> ${item.test} (${item.reason})`).join('\n')}`);
  return fitSections(sections, budget);
}

function renderOverviewSummary(summary: ReturnType<typeof buildArchitectureSummary>): string {
  const sections = ['Project overview'];
  sections.push(`Layers:\n${Object.entries(summary.layers).filter(([, files]) => files.length).map(([name, files]) => `  ${name}: ${files.slice(0, 8).join(', ')}`).join('\n')}`);
  if (summary.routes.length) sections.push(`API surface: ${summary.routes.length} routes, ${summary.rpc.length} RPC methods`);
  if (summary.dependencies.length) sections.push(`Runtime app dependencies: ${summary.dependencies.map((item) => item.key).slice(0, 25).join(', ')}`);
  if (summary.tables.length) sections.push(`Persistence: ${summary.tables.map((item) => item.name).slice(0, 25).join(', ')}`);
  if (summary.testRelations.length) sections.push(`Test strategy hints:\n${summary.testRelations.slice(0, 12).map((item) => `  ${item.source} -> ${item.test}`).join('\n')}`);
  return sections.join('\n\n');
}

function renderEditPrepSummary(summary: ReturnType<typeof buildArchitectureSummary>, goal: string): string {
  const query = goal.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 2);
  const relevantFiles = summary.files.filter((file) => query.some((term) => `${file.path} ${file.classes.join(' ')} ${file.functions.join(' ')} ${file.rpcMethods.join(' ')}`.toLowerCase().includes(term))).slice(0, 10);
  const relevantTests = summary.testRelations.filter((item) => relevantFiles.some((file) => file.path === item.source)).slice(0, 12);
  const sections = ['Edit prep'];
  sections.push(`Goal: ${goal}`);
  if (relevantFiles.length) sections.push(`Read first:\n${relevantFiles.map((file) => `  codebone skeleton ${file.path} --mode public_api`).join('\n')}`);
  if (summary.changed.length) sections.push(`Dirty tree blast radius:\n${summary.changed.map((item) => `  ${item.path}${item.tests.length ? ` -> tests: ${item.tests.join(', ')}` : ''}`).join('\n')}`);
  if (relevantTests.length) sections.push(`Likely tests:\n${relevantTests.map((item) => `  ${item.test} (${item.reason}, covers ${item.source})`).join('\n')}`);
  sections.push('Next step: use codebone_read with symbolId or lines for only the selected method/body before editing.');
  return sections.join('\n\n');
}

function renderCompositionSummary(summary: ReturnType<typeof buildArchitectureSummary>, budget: number): string {
  const sections = ['Composition root summary'];
  const rootFiles = Array.from(new Set([...summary.layers.entrypoints, ...summary.files.filter((file) => /(^|\/)app\.py$/.test(file.path)).map((file) => file.path)]));
  if (rootFiles.length) sections.push(`Composition files:\n${rootFiles.map((file) => `  ${file}`).join('\n')}`);
  if (summary.routes.length) sections.push(`Routes/subapps:\n${summary.routes.slice(0, 40).map((item) => `  ${item.route} -> ${item.handler ?? 'unknown'} (${item.file}:${item.line})`).join('\n')}`);
  const lifecycle = summary.files.flatMap((file) => [...file.functions, ...file.rpcMethods].filter((name) => /startup|shutdown|cleanup|setup|init|destroy|create_app|make_app/i.test(name)).map((name) => ({ file: file.path, name })));
  if (lifecycle.length) sections.push(`Lifecycle:\n${lifecycle.map((item) => `  ${item.name} (${item.file})`).join('\n')}`);
  if (summary.dependencies.length) sections.push(`App dependencies:\n${summary.dependencies.map((item) => {
    const writes = item.writes.length ? `created ${item.writes.map((usage) => `${usage.file}:${usage.line}${usage.value ? ` = ${usage.value}` : ''}`).join(', ')}` : 'no creator found';
    const reads = item.reads.length ? `; read ${item.reads.slice(0, 5).map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : '';
    const lifecycle = `${item.starts.length ? `; start ${item.starts.map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : ''}${item.stops.length ? `; stop ${item.stops.map((usage) => `${usage.file}:${usage.line}`).join(', ')}` : ''}${item.starts.length && !item.stops.length ? '; risk: started but no stop found' : ''}`;
    return `  app["${item.key}"] ${writes}${reads}${lifecycle}`;
  }).join('\n')}`);
  if (summary.layers.integrations.length) sections.push(`External integrations:\n${summary.layers.integrations.slice(0, 15).map((file) => `  ${file}`).join('\n')}`);
  if (summary.layers.background.length) sections.push(`Background jobs/consumers:\n${summary.layers.background.slice(0, 15).map((file) => `  ${file}`).join('\n')}`);
  return fitSections(sections, budget);
}

function renderTestImpactSummary(summary: ReturnType<typeof buildArchitectureSummary>, goal: string): string {
  const query = goal.toLowerCase().split(/[^a-z0-9_./]+/).filter((term) => term.length > 2);
  const scored = summary.testRelations.map((relation) => {
    const haystack = `${relation.source} ${relation.test}`.toLowerCase();
    const score = query.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) + (relation.reason === 'import' ? 2 : relation.reason === 'symbol_mention' ? 1.5 : 1);
    return { ...relation, score };
  }).filter((relation) => relation.score > 0).sort((a, b) => b.score - a.score || a.test.localeCompare(b.test)).slice(0, 12);
  const sections = [`Test impact for: ${goal}`];
  if (scored.length) sections.push(`Pytest candidates:\n${scored.map((item) => `  ${item.test} (covers ${item.source}; ${item.reason})`).join('\n')}`);
  const fixtureHints = Array.from(new Set(scored.flatMap((item) => [item.test, item.source]).filter((file) => /fixture|mock|fake|conftest/i.test(file))));
  const external = Array.from(new Set(scored.flatMap((item) => [item.test, item.source]).join(' ').match(/redis|rabbit|postgres|mongo|kafka/gi) ?? [])).map((item) => item.toLowerCase());
  if (fixtureHints.length) sections.push(`Fixture/mock hints:\n${fixtureHints.map((item) => `  ${item}`).join('\n')}`);
  if (external.length) sections.push(`External services hinted by paths: ${external.join(', ')}`);
  if (!scored.length) sections.push('No direct test relation found. Use codebone_symbols for the changed symbol, then run nearest API/task tests by path proximity.');
  return sections.join('\n\n');
}

function summarizeLayers(fileRecords: Array<{ path: string }>) {
  const layers: Record<string, string[]> = { entrypoints: [], api: [], services: [], persistence: [], background: [], integrations: [], tests: [] };
  for (const record of fileRecords) {
    const filePath = record.path;
    if (/(^|\/)(app|main|server|cli)\.py$/.test(filePath)) layers.entrypoints.push(filePath);
    if (/api|route|handler|view|rpc/i.test(filePath)) layers.api.push(filePath);
    if (/service|accessor|observer/i.test(filePath)) layers.services.push(filePath);
    if (/dao|db|model|table|repository/i.test(filePath)) layers.persistence.push(filePath);
    if (/task|worker|consumer|job|scheduler/i.test(filePath)) layers.background.push(filePath);
    if (/rabbit|redis|postgres|port|client|publisher|sender/i.test(filePath)) layers.integrations.push(filePath);
    if (isTestPath(filePath)) layers.tests.push(filePath);
  }
  return layers;
}

function fitSections(sections: string[], budget: number): string {
  const kept: string[] = [];
  for (const section of sections) {
    const candidate = [...kept, section].join('\n\n');
    if (kept.length > 0 && estimateTokens(candidate) > budget) break;
    kept.push(section);
  }
  return kept.join('\n\n');
}

function buildAppDependencyGraph(fileRecords: Array<{ path: string; symbols: ReturnType<typeof flattenSymbols> }>) {
  const byKey = new Map<string, { key: string; writes: Array<{ file: string; line: number; value?: string }>; reads: Array<{ file: string; line: number }>; starts: Array<{ file: string; line: number }>; stops: Array<{ file: string; line: number }> }>();
  for (const record of fileRecords) {
    for (const symbol of record.symbols.filter((item) => item.kind === 'dependency')) {
      const entry = byKey.get(symbol.name) ?? { key: symbol.name, writes: [], reads: [], starts: [], stops: [] };
      const usage = { file: record.path, line: symbol.startLine };
      if (/\b(?:app|request\.app)\[['"][^'"]+['"]\]\s*=/.test(symbol.signature)) entry.writes.push({ ...usage, value: symbol.signature.split('=').slice(1).join('=').trim().slice(0, 80) });
      else if (/\[['"][^'"]+['"]\]\.(?:start|startup)\s*\(/.test(symbol.signature)) entry.starts.push(usage);
      else if (/\[['"][^'"]+['"]\]\.(?:stop|close|shutdown|cleanup)\s*\(/.test(symbol.signature)) entry.stops.push(usage);
      else entry.reads.push(usage);
      byKey.set(symbol.name, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.writes.length > 0) - Number(a.writes.length > 0) || a.key.localeCompare(b.key));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRpcSummary(fileRecords: Array<{ path: string; symbols: ReturnType<typeof flattenSymbols> }>, dependencies: ReturnType<typeof buildAppDependencyGraph>) {
  const dependencyKeys = new Set(dependencies.map((dependency) => dependency.key));
  return fileRecords.flatMap((record) => record.symbols.filter((symbol) => ['function', 'method'].includes(symbol.kind) && symbol.name.startsWith('rpc_')).map((symbol) => {
    const deps = record.symbols
      .filter((item) => item.kind === 'dependency' && item.startLine >= symbol.startLine && item.endLine <= symbol.endLine && dependencyKeys.has(item.name))
      .map((item) => item.name);
    return { file: record.path, name: symbol.qualifiedName, line: symbol.startLine, dependencies: Array.from(new Set(deps)) };
  }));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function renderContext(data: Awaited<ReturnType<typeof buildContext>>): string {
  if (data.mode === 'architecture' || data.mode === 'overview' || data.mode === 'edit_prep' || data.mode === 'composition' || data.mode === 'test_impact') return data.items[0]?.content ?? `${data.mode} summary: empty`;
  const relatedTests = data.testRelations.length ? `\n\nRelated tests:\n${data.testRelations.slice(0, 10).map((item) => `  ${item.test} -> ${item.source} (${item.reason})`).join('\n')}` : '';
  const files = data.files.length
    ? `\n\nFiles:\n${data.files.map((file) => `  ${file.path} (${file.reason})\n${file.symbols.map((symbol) => `    - ${symbol.name} ${symbol.range.startLine}:${symbol.range.endLine}`).join('\n')}`).join('\n')}`
    : '';
  const nextReads = data.suggestedNextReads.map((item) => `  ${item.tool} ${Object.entries(item.args).map(([key, value]) => `${key}=${String(value)}`).join(' ')}`).join('\n');
  return `# codebone context pack\n\nGoal: ${data.goal}\nBudget: ${data.budget}\nEstimated tokens: ${data.tokenEstimate}\n\nContext pack: ${data.usedTokens} tokens, ${data.items.length} included${files}\n\nSuggested next reads:\n${nextReads}${relatedTests}`;
}
