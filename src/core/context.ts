import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SCHEMA_VERSION } from '../types.js';
import { walkSourceFiles } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens } from './budget.js';
import { resolveImport, summarizeGraph } from './graph.js';
import { readCode } from './reader.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

const execFileAsync = promisify(execFile);

export interface ContextOptions {
  goal: string;
  path?: string;
  budget?: number;
  includeTests?: boolean;
  changedOnly?: boolean;
  mode?: 'full' | 'architecture' | 'overview' | 'edit_prep';
  productionOnly?: boolean;
  testsOnly?: boolean;
  includeMocks?: boolean;
  includeConfig?: boolean;
  includeMigrations?: boolean;
}

export async function buildContext(root: string, options: ContextOptions) {
  const budget = options.budget ?? 8000;
  const warnings: string[] = [];
  const terms = options.goal.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 2);
  const changedFiles = await getChangedFiles(root);
  const files = (await walkSourceFiles(root, options.path ?? '.', { maxFiles: 1000 }))
    .filter((file) => !options.changedOnly || changedFiles.has(file.relativePath))
    .filter((file) => includeByContextFilters(file.relativePath, options));
  const ranked = [] as Array<{ path: string; score: number; reason: string; tokens: number; content: string; symbolId?: string }>;
  const fileRecords = [] as Array<{ path: string; source: string; imports: string[]; exported: Array<{ name: string; kind: string }>; symbols: ReturnType<typeof flattenSymbols>; symbolText: string; tokens: number; size: number; content: string; symbolId?: string }>;
  const omittedFiles = [] as Array<{ path: string; reason: string }>;
  for (const file of files) {
    if (options.includeTests === false && /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(file.relativePath)) {
      omittedFiles.push({ path: file.relativePath, reason: 'includeTests:false' });
      continue;
    }
    try {
      const { text: source } = await readTextFileSafe(file.absolutePath, undefined, root);
      const skeleton = await skeletonSourceAsync(root, file.relativePath, source, { budget: Math.min(2000, budget) });
      const symbols = flattenSymbols(skeleton.symbols);
      const content = JSON.stringify(skeleton, null, 2);
      fileRecords.push({ path: file.relativePath, source, imports: symbols.filter((symbol) => symbol.kind === 'import').map((symbol) => symbol.source ?? symbol.signature), exported: symbols.filter((symbol) => symbol.exported).map((symbol) => ({ name: symbol.qualifiedName, kind: symbol.kind })), symbols, symbolText: symbols.map((symbol) => `${symbol.name} ${symbol.signature}`).join('\n'), tokens: skeleton.tokenEstimate, size: file.size, content, symbolId: symbols.find((symbol) => symbol.kind !== 'import')?.symbolId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /File too large/i.test(message) ? 'file_too_large' : /Binary/i.test(message) ? 'unsupported_binary' : `parse_or_read_error:${message}`;
      omittedFiles.push({ path: file.relativePath, reason });
      warnings.push(`omitted:${file.relativePath}:${reason}`);
    }
  }
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
    if (score > 0) ranked.push({ path: record.path, score, reason: reasons.join(', ') || 'structural match', tokens: record.tokens, content: record.content, symbolId: record.symbolId });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const items = [] as Array<{ type: 'skeleton' | 'symbol_body'; path: string; score: number; reason: string; content: string; symbolId?: string }>;
  let usedTokens = 0;
  const testRelations = inferTestRelations(fileRecords, graph.edges).slice(0, 30);
  if (options.mode === 'architecture' || options.mode === 'overview' || options.mode === 'edit_prep') {
    const architecture = buildArchitectureSummary(fileRecords, graph.edges, testRelations, changedFiles);
    const content = options.mode === 'overview'
      ? renderOverviewSummary(architecture)
      : options.mode === 'edit_prep'
        ? renderEditPrepSummary(architecture, options.goal)
        : renderArchitectureSummary(architecture, budget);
    const omitted = omittedFiles.slice(0, 20);
    const data = { schemaVersion: SCHEMA_VERSION, goal: options.goal, mode: options.mode, budget, usedTokens: estimateTokens(content), items: [{ type: `${options.mode}_summary` as const, path: options.path ?? '.', score: 1, reason: `compact ${options.mode} summary`, content }], omitted, nextReads: ranked.slice(0, 10).map((item) => ({ command: 'skeleton', path: item.path, symbolId: item.symbolId })), architecture, testRelations, warnings, truncated: omitted.length > 0 || estimateTokens(renderArchitectureSummary(architecture)) > budget, tokenEstimate: estimateTokens(content) };
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
  const data = { schemaVersion: SCHEMA_VERSION, goal: options.goal, mode: 'full' as const, budget, usedTokens, items, omitted, nextReads, testRelations, warnings, truncated: omitted.length > 0, tokenEstimate: estimateTokens(JSON.stringify(items)) };
  return data;
}

async function getChangedFiles(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, timeout: 2000 });
    return new Set(stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).map((file) => file.replace(/\\/g, '/')));
  } catch {
    return new Set();
  }
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
    return `  app["${item.key}"]${writes}${reads}`;
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
  const byKey = new Map<string, { key: string; writes: Array<{ file: string; line: number; value?: string }>; reads: Array<{ file: string; line: number }> }>();
  for (const record of fileRecords) {
    for (const symbol of record.symbols.filter((item) => item.kind === 'dependency')) {
      const entry = byKey.get(symbol.name) ?? { key: symbol.name, writes: [], reads: [] };
      const usage = { file: record.path, line: symbol.startLine };
      if (/\b(?:app|request\.app)\[['"][^'"]+['"]\]\s*=/.test(symbol.signature)) entry.writes.push({ ...usage, value: symbol.signature.split('=').slice(1).join('=').trim().slice(0, 80) });
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
  if (data.mode === 'architecture') return data.items[0]?.content ?? 'Architecture summary: empty';
  const relatedTests = data.testRelations.length ? `\n\nRelated tests:\n${data.testRelations.slice(0, 10).map((item) => `  ${item.test} -> ${item.source} (${item.reason})`).join('\n')}` : '';
  return `Context pack: ${data.usedTokens} tokens, ${data.items.length} included\n\n${data.items.map((item, index) => `${index + 1}. ${item.path} ${item.type} (${item.reason})`).join('\n')}\n\nNext reads:\n${data.nextReads.map((item) => `  codebone ${item.command} ${item.path}`).join('\n')}${relatedTests}`;
}
