import fs from 'node:fs/promises';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { CodeSymbol, SCHEMA_VERSION } from '../types.js';
import { loadConfig } from '../utils/config.js';
import { CodeboneError, warning } from '../utils/errors.js';
import { walkSourceFilesDetailed } from '../utils/file-walker.js';
import { resolveInsideRoot, toRelative } from '../utils/paths.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';
import { resolveImport } from './graph.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

export interface ImpactOptions {
  symbol?: string;
  symbolId?: string;
  lines?: string;
  budget?: number;
}

export interface ImpactResult {
  schemaVersion: typeof SCHEMA_VERSION;
  target: {
    path: string;
    symbol?: {
      id: string;
      name: string;
      kind: string;
      range: { startLine: number; endLine: number };
    };
    lines?: { startLine: number; endLine: number };
  };
  tokenEstimate: number;
  tokenEstimator: typeof TOKEN_ESTIMATOR;
  truncated: boolean;
  warnings: string[];
  imports: Array<{ path: string; specifier: string; resolvedPath?: string }>;
  importedBy: Array<{ path: string; reason: string; confidence: 'high' | 'medium' | 'low' }>;
  references: Array<{ path: string; symbolName: string; line: number; reason: string; confidence: 'high' | 'medium' | 'low' }>;
  likelyTests: Array<{ path: string; reason: string; confidence: 'high' | 'medium' | 'low' }>;
  related: Array<{ path: string; symbol?: string; relationship: 'extends' | 'implements' | 'overrides' | 'decorates' | 'calls' | 'exports'; reason: string; confidence: 'high' | 'medium' | 'low' }>;
  suggestedNextReads: Array<{ tool: 'codebone_read' | 'codebone_skeleton' | 'codebone_context'; args: Record<string, unknown>; reason: string; priority: 'high' | 'medium' | 'low' }>;
}

export async function analyzeImpact(root: string, inputPath: string, options: ImpactOptions = {}): Promise<ImpactResult> {
  const config = await loadConfig(root);
  const budget = options.budget ?? Math.min(6000, config.maxBudget);
  if (!Number.isInteger(budget) || budget < 1000 || budget > config.maxBudget) throw new CodeboneError('INVALID_INPUT', `budget must be an integer between 1000 and ${config.maxBudget}`);
  validateTargetSelector(options);

  const absolutePath = resolveInsideRoot(root, inputPath);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CodeboneError('PATH_NOT_FOUND', `Path not found: ${inputPath}`);
    throw error;
  }
  if (stat.isDirectory()) throw new CodeboneError('INVALID_INPUT', 'impact expects a file path. Use codebone_context for directory-level exploration.');
  const targetPath = toRelative(root, absolutePath);
  const warnings: string[] = [...config.warnings];
  const { text: source } = await readTextFileSafe(absolutePath, config.maxFileBytes, root);
  const lines = source.split(/\r?\n/);
  const skeleton = await skeletonSourceAsync(root, targetPath, source);
  if (skeleton.warnings.length) warnings.push(warning('PARSE_FALLBACK', targetPath));
  const targetSymbols = flattenSymbols(skeleton.symbols).sort(compareSymbols);
  const targetSelection = selectTarget(targetPath, targetSymbols, lines.length, options, warnings);
  const targetNames = targetSelection.symbol ? [targetSelection.symbol.name, targetSelection.symbol.qualifiedName] : [];

  const discovery = await walkSourceFilesDetailed(root, '.', { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, timeoutMs: config.timeoutMs });
  warnings.push(...discovery.warnings);
  const fileSet = new Set(discovery.files.map((file) => file.relativePath));
  const testMatchers = config.testPatterns.map((pattern) => new Minimatch(pattern, { dot: true }));

  const imports = uniqueBy([
    ...targetSymbols.filter((symbol) => symbol.kind === 'import' && symbol.source).map((symbol) => symbol.source!),
    ...extractImportSpecifiers(source),
  ], (item) => item)
    .map((specifier) => ({ path: targetPath, specifier, resolvedPath: resolveImport(targetPath, specifier, fileSet) }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier));
  if (imports.some((item) => !item.resolvedPath && !item.specifier.startsWith('.'))) warnings.push(warning('IMPORT_RESOLUTION_LIMITED', 'non-relative imports are not resolved in this release'));

  const importedBy: ImpactResult['importedBy'] = [];
  const references: ImpactResult['references'] = [];
  const likelyTests: ImpactResult['likelyTests'] = [];
  const related: ImpactResult['related'] = [];

  for (const file of discovery.files) {
    try {
      const { text } = file.relativePath === targetPath ? { text: source } : await readTextFileSafe(file.absolutePath, config.maxFileBytes, root);
      const fileSkeleton = file.relativePath === targetPath ? skeleton : await skeletonSourceAsync(root, file.relativePath, text);
      if (fileSkeleton.warnings.length) warnings.push(warning('PARSE_FALLBACK', file.relativePath));
      const symbols = flattenSymbols(fileSkeleton.symbols).sort(compareSymbols);
      const importSpecifiers = uniqueBy([...symbols.filter((symbol) => symbol.kind === 'import' && symbol.source).map((symbol) => symbol.source!), ...extractImportSpecifiers(text)], (item) => item);
      const localImport = importSpecifiers.find((specifier) => resolveImport(file.relativePath, specifier, fileSet) === targetPath);
      if (localImport && file.relativePath !== targetPath) importedBy.push({ path: file.relativePath, reason: `imports ${targetPath}`, confidence: 'high' });
      if (targetNames.length) references.push(...findTextReferences(file.relativePath, text, targetNames[0], file.language));
      if (isLikelyTest(file.relativePath, testMatchers) && isRelatedTest(file.relativePath, text, targetPath, targetNames[0], localImport)) {
        likelyTests.push({ path: file.relativePath, reason: testReason(file.relativePath, targetPath, targetNames[0], Boolean(localImport)), confidence: localImport ? 'high' : 'medium' });
      }
      related.push(...detectRelationships(file.relativePath, text, targetSelection.symbol, targetNames[0]));
    } catch (error) {
      warnings.push(warning('PARSE_ERROR', `${file.relativePath}:${error instanceof Error ? error.message : String(error)}`));
    }
  }

  const suggestedNextReads = buildImpactSuggestions(targetPath, targetSelection.symbol, importedBy, likelyTests, references);
  let result: ImpactResult = {
    schemaVersion: SCHEMA_VERSION,
    target: targetSelection.target,
    tokenEstimate: 0,
    tokenEstimator: TOKEN_ESTIMATOR,
    truncated: false,
    warnings,
    imports,
    importedBy: uniqueBy(importedBy, (item) => item.path).sort(comparePathConfidence),
    references: uniqueBy(references, (item) => `${item.path}:${item.line}:${item.symbolName}`).sort(compareReferences),
    likelyTests: uniqueBy(likelyTests, (item) => item.path).sort(comparePathConfidence),
    related: uniqueBy(related, (item) => `${item.path}:${item.relationship}:${item.symbol ?? ''}`).sort(compareRelated),
    suggestedNextReads,
  };
  result = fitImpactBudget(result, budget);
  result.tokenEstimate = estimateImpactTokens(result);
  if (result.tokenEstimate > budget) {
    result.truncated = true;
    if (!result.warnings.some((item) => item.startsWith('BUDGET_TOO_SMALL'))) result.warnings.push(warning('BUDGET_TOO_SMALL', 'minimal impact result exceeds budget'));
  }
  return result;
}

export function renderImpact(data: ImpactResult): string {
  const target = data.target.symbol ? `${data.target.path}#${data.target.symbol.name}` : data.target.lines ? `${data.target.path}:${data.target.lines.startLine}:${data.target.lines.endLine}` : data.target.path;
  const sections = [`# codebone impact`, `Target: ${target}\nEstimated tokens: ${data.tokenEstimate}`];
  if (data.importedBy.length) sections.push(`## Imported by\n\n${data.importedBy.map((item) => `- ${item.path} - ${item.reason} - ${item.confidence}`).join('\n')}`);
  if (data.references.length) sections.push(`## References\n\n${data.references.slice(0, 30).map((item) => `- ${item.path}:${item.line} - ${item.reason} - ${item.confidence}`).join('\n')}`);
  if (data.likelyTests.length) sections.push(`## Likely tests\n\n${data.likelyTests.map((item) => `- ${item.path} - ${item.reason} - ${item.confidence}`).join('\n')}`);
  if (data.related.length) sections.push(`## Related\n\n${data.related.map((item) => `- ${item.path}${item.symbol ? `#${item.symbol}` : ''} - ${item.relationship} - ${item.confidence}`).join('\n')}`);
  if (data.suggestedNextReads.length) sections.push(`## Suggested next reads\n\n${data.suggestedNextReads.map((item) => `- ${item.tool} ${Object.entries(item.args).map(([key, value]) => `${key}=${String(value)}`).join(' ')}`).join('\n')}`);
  return sections.join('\n\n');
}

function validateTargetSelector(options: ImpactOptions): void {
  const selectors = [options.symbol, options.symbolId, options.lines].filter((value) => value !== undefined);
  if (selectors.length > 1) throw new CodeboneError('INVALID_INPUT', 'Pass at most one of --symbol, --symbol-id, or --lines');
}

function selectTarget(targetPath: string, symbols: CodeSymbol[], lineCount: number, options: ImpactOptions, warnings: string[]) {
  if (options.symbolId) {
    const match = symbols.find((symbol) => symbol.symbolId === options.symbolId);
    if (!match) throw new CodeboneError('SYMBOL_NOT_FOUND', `symbolId not found in ${targetPath}`);
    return { symbol: match, target: symbolTarget(targetPath, match) };
  }
  if (options.symbol) {
    const matches = symbols.filter((symbol) => symbol.name === options.symbol || symbol.qualifiedName === options.symbol);
    if (matches.length === 0) throw new CodeboneError('SYMBOL_NOT_FOUND', `Symbol "${options.symbol}" not found in ${targetPath}`);
    if (matches.length > 1) throw new CodeboneError('AMBIGUOUS_SYMBOL', `Symbol "${options.symbol}" matched multiple symbols in ${targetPath}`, { candidates: matches.map((symbol) => ({ id: symbol.symbolId, name: symbol.qualifiedName, line: symbol.startLine })) });
    return { symbol: matches[0], target: symbolTarget(targetPath, matches[0]) };
  }
  if (options.lines) {
    const match = options.lines.match(/^(\d+):(\d+)$/);
    if (!match) throw new CodeboneError('INVALID_INPUT', 'lines must use start:end');
    const startLine = Number(match[1]);
    let endLine = Number(match[2]);
    if (startLine < 1 || endLine < startLine) throw new CodeboneError('INVALID_INPUT', 'lines must be positive and start <= end');
    if (startLine > lineCount) throw new CodeboneError('INVALID_INPUT', `line range starts after EOF (${lineCount} lines)`);
    if (endLine > lineCount) {
      endLine = lineCount;
      warnings.push(warning('TRUNCATED', 'line range clamped to EOF'));
    }
    return { symbol: symbols.find((symbol) => symbol.startLine <= startLine && symbol.endLine >= endLine), target: { path: targetPath, lines: { startLine, endLine } } };
  }
  return { symbol: undefined, target: { path: targetPath } };
}

function symbolTarget(targetPath: string, symbol: CodeSymbol): ImpactResult['target'] {
  return { path: targetPath, symbol: { id: symbol.symbolId, name: symbol.qualifiedName, kind: symbol.kind, range: { startLine: symbol.startLine, endLine: symbol.endLine } } };
}

function findTextReferences(filePath: string, text: string, symbolName: string, language: string): ImpactResult['references'] {
  const pattern = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
  const references: ImpactResult['references'] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    if (!pattern.test(line)) continue;
    const commentOnly = /^\s*(\/\/|#|\/\*|\*)/.test(line);
    references.push({ path: filePath, symbolName, line: index + 1, reason: `mentions ${symbolName}`, confidence: commentOnly || language === 'unknown' ? 'low' : 'medium' });
  }
  return references;
}

function isLikelyTest(filePath: string, matchers: Minimatch[]): boolean {
  return matchers.some((matcher) => matcher.match(filePath)) || /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(filePath);
}

function isRelatedTest(filePath: string, text: string, targetPath: string, symbolName: string | undefined, importsTarget: unknown): boolean {
  if (importsTarget) return true;
  const base = path.posix.basename(targetPath).replace(/\.[^.]+$/, '').toLowerCase();
  const testBase = path.posix.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
  return Boolean(symbolName && new RegExp(`\\b${escapeRegExp(symbolName)}\\b`).test(text)) || testBase.includes(base);
}

function testReason(filePath: string, targetPath: string, symbolName: string | undefined, importsTarget: boolean): string {
  if (importsTarget) return `imports ${targetPath}`;
  if (symbolName) return `mentions ${symbolName}`;
  return `test path resembles ${targetPath}`;
}

function detectRelationships(filePath: string, text: string, symbol: CodeSymbol | undefined, symbolName: string | undefined): ImpactResult['related'] {
  const related: ImpactResult['related'] = [];
  if (!symbolName) return related;
  const escaped = escapeRegExp(symbolName);
  if (new RegExp(`\\bextends\\s+${escaped}\\b`).test(text)) related.push({ path: filePath, symbol: symbolName, relationship: 'extends', reason: `extends ${symbolName}`, confidence: 'medium' });
  if (new RegExp(`\\bimplements\\s+${escaped}\\b`).test(text)) related.push({ path: filePath, symbol: symbolName, relationship: 'implements', reason: `implements ${symbolName}`, confidence: 'medium' });
  if (/\boverride\s+\w+\s*\(/.test(text)) related.push({ path: filePath, symbol: symbol?.name, relationship: 'overrides', reason: 'contains explicit override method', confidence: 'medium' });
  if (new RegExp(`@\\w+\\s*\\n\\s*(?:export\\s+)?class\\s+${escaped}\\b`).test(text) || new RegExp(`@${escaped}\\b`).test(text)) related.push({ path: filePath, symbol: symbolName, relationship: 'decorates', reason: `decorator relationship involving ${symbolName}`, confidence: 'low' });
  if (new RegExp(`\\b${escaped}\\s*\\(`).test(text)) related.push({ path: filePath, symbol: symbolName, relationship: 'calls', reason: `calls ${symbolName}`, confidence: 'medium' });
  if (new RegExp(`export\\s+\\{[^}]*\\b${escaped}\\b`).test(text) || new RegExp(`export\\s+.*\\b${escaped}\\b`).test(text)) related.push({ path: filePath, symbol: symbolName, relationship: 'exports', reason: `exports ${symbolName}`, confidence: 'medium' });
  return related;
}

function extractImportSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function buildImpactSuggestions(targetPath: string, symbol: CodeSymbol | undefined, importedBy: ImpactResult['importedBy'], likelyTests: ImpactResult['likelyTests'], references: ImpactResult['references']): ImpactResult['suggestedNextReads'] {
  const suggestions: ImpactResult['suggestedNextReads'] = [];
  suggestions.push({ tool: 'codebone_read', args: symbol ? { path: targetPath, symbolId: symbol.symbolId } : { path: targetPath }, reason: 'read the target before editing', priority: 'high' });
  for (const item of importedBy.slice(0, 2)) suggestions.push({ tool: 'codebone_skeleton', args: { path: item.path }, reason: 'inspect direct importer', priority: 'high' });
  for (const item of likelyTests.slice(0, 2)) suggestions.push({ tool: 'codebone_read', args: { path: item.path, lines: '1:160' }, reason: 'inspect likely test coverage', priority: 'medium' });
  if (references[0]) suggestions.push({ tool: 'codebone_context', args: { goal: `change ${symbol?.name ?? targetPath}`, path: '.' }, reason: 'assemble broader edit context', priority: 'low' });
  return uniqueBy(suggestions, (item) => `${item.tool}:${JSON.stringify(item.args)}`).slice(0, 5).sort(compareSuggestions);
}

function fitImpactBudget(result: ImpactResult, budget: number): ImpactResult {
  result.suggestedNextReads = result.suggestedNextReads.slice(0, 5);
  const clone = () => ({ ...result, warnings: [...result.warnings] });
  let current = clone();
  if (estimateImpactTokens(current) <= budget) return current;
  current.truncated = true;
  if (!current.warnings.some((item) => item.startsWith('TRUNCATED'))) current.warnings.push(warning('TRUNCATED', 'impact result reduced to fit budget'));
  const reducers: Array<() => boolean> = [
    () => reduceList(current.references, (items) => { current.references = items; }),
    () => reduceList(current.related, (items) => { current.related = items; }),
    () => reduceList(current.importedBy, (items) => { current.importedBy = items; }),
  ];
  for (const reduce of reducers) {
    while (estimateImpactTokens(current) > budget && reduce()) {
      // Keep reducing the current section until it reaches its minimum useful size.
    }
  }
  if (estimateImpactTokens(current) > budget && !current.warnings.some((item) => item.startsWith('BUDGET_TOO_SMALL'))) current.warnings.push(warning('BUDGET_TOO_SMALL', 'minimal impact result exceeds budget'));
  return current;
}

function reduceList<T>(items: T[], update: (items: T[]) => void): boolean {
  if (items.length <= 5) return false;
  const next = items.slice(0, Math.max(5, Math.floor(items.length / 2)));
  if (next.length === items.length) return false;
  update(next);
  return true;
}

function estimateImpactTokens(result: ImpactResult): number {
  return estimateTokens(renderImpact({ ...result, tokenEstimate: 0 }));
}

function compareSymbols(a: CodeSymbol, b: CodeSymbol): number {
  return a.file.localeCompare(b.file) || a.startLine - b.startLine || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function comparePathConfidence(a: { path: string; confidence: string; reason?: string }, b: { path: string; confidence: string; reason?: string }): number {
  return confidenceOrder(a.confidence) - confidenceOrder(b.confidence) || a.path.localeCompare(b.path) || String(a.reason ?? '').localeCompare(String(b.reason ?? ''));
}

function compareReferences(a: ImpactResult['references'][number], b: ImpactResult['references'][number]): number {
  return confidenceOrder(a.confidence) - confidenceOrder(b.confidence) || a.path.localeCompare(b.path) || a.line - b.line || a.symbolName.localeCompare(b.symbolName) || a.reason.localeCompare(b.reason);
}

function compareRelated(a: ImpactResult['related'][number], b: ImpactResult['related'][number]): number {
  return confidenceOrder(a.confidence) - confidenceOrder(b.confidence) || a.path.localeCompare(b.path) || a.relationship.localeCompare(b.relationship) || String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')) || a.reason.localeCompare(b.reason);
}

function compareSuggestions(a: ImpactResult['suggestedNextReads'][number], b: ImpactResult['suggestedNextReads'][number]): number {
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return order[a.priority] - order[b.priority] || a.tool.localeCompare(b.tool) || JSON.stringify(a.args).localeCompare(JSON.stringify(b.args));
}

function confidenceOrder(value: string): number {
  return ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[value] ?? 3;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
