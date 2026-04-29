import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SCHEMA_VERSION } from '../types.js';
import { walkSourceFiles } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens } from './budget.js';
import { resolveImport, summarizeGraph } from './graph.js';
import { buildIndex } from './indexer.js';
import { readCode } from './reader.js';
import { skeletonSourceAsync } from './skeleton.js';

const execFileAsync = promisify(execFile);

export interface ContextOptions {
  goal: string;
  path?: string;
  budget?: number;
  includeTests?: boolean;
  changedOnly?: boolean;
}

export async function buildContext(root: string, options: ContextOptions) {
  const budget = options.budget ?? 8000;
  const warnings: string[] = [];
  try {
    await buildIndex(root, options.path ?? '.');
  } catch (error) {
    warnings.push(`index_unavailable:${error instanceof Error ? error.message : String(error)}`);
  }
  const terms = options.goal.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 2);
  const changedFiles = await getChangedFiles(root);
  const files = (await walkSourceFiles(root, options.path ?? '.', { maxFiles: 1000 })).filter((file) => !options.changedOnly || changedFiles.has(file.relativePath));
  const ranked = [] as Array<{ path: string; score: number; reason: string; tokens: number; content: string; symbolId?: string }>;
  const fileRecords = [] as Array<{ path: string; source: string; imports: string[]; exported: Array<{ name: string; kind: string }>; symbolText: string; tokens: number; size: number; content: string; symbolId?: string }>;
  for (const file of files) {
    const { text: source } = await readTextFileSafe(file.absolutePath, undefined, root);
    if (options.includeTests === false && /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(file.relativePath)) continue;
    const skeleton = await skeletonSourceAsync(root, file.relativePath, source, { budget: Math.min(2000, budget) });
    const content = JSON.stringify(skeleton, null, 2);
    fileRecords.push({ path: file.relativePath, source, imports: skeleton.symbols.filter((symbol) => symbol.kind === 'import').map((symbol) => symbol.source ?? symbol.signature), exported: skeleton.symbols.filter((symbol) => symbol.exported).map((symbol) => ({ name: symbol.qualifiedName, kind: symbol.kind })), symbolText: skeleton.symbols.map((symbol) => `${symbol.name} ${symbol.signature}`).join('\n'), tokens: skeleton.tokenEstimate, size: file.size, content, symbolId: skeleton.symbols.find((symbol) => symbol.kind !== 'import')?.symbolId });
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
  for (const item of ranked) {
    if (usedTokens + item.tokens > budget) break;
    items.push({ type: 'skeleton', path: item.path, score: Number(item.score.toFixed(2)), reason: item.reason, content: item.content });
    usedTokens += item.tokens;
  }
  for (const item of ranked.filter((rankedItem) => rankedItem.symbolId)) {
    if (usedTokens >= budget) break;
    const body = await readCode(root, item.path, { symbolId: item.symbolId, maxBytes: Math.min(12000, (budget - usedTokens) * 4) });
    if (usedTokens + body.tokenEstimate > budget) continue;
    items.push({ type: 'symbol_body', path: item.path, symbolId: item.symbolId, score: Number(item.score.toFixed(2)), reason: 'top ranked symbol body within remaining budget', content: body.content });
    usedTokens += body.tokenEstimate;
  }
  const nextReads = ranked.slice(0, 5).map((item) => ({ command: item.symbolId ? 'read' : 'skeleton', path: item.path, symbolId: item.symbolId }));
  const included = new Set(items.map((item) => `${item.type}:${item.path}:${item.symbolId ?? ''}`));
  const omitted = ranked.filter((item) => !included.has(`skeleton:${item.path}:`)).slice(0, 20).map((item) => ({ path: item.path, reason: 'budget' }));
  const data = { schemaVersion: SCHEMA_VERSION, goal: options.goal, budget, usedTokens, items, omitted, nextReads, warnings, truncated: omitted.length > 0, tokenEstimate: estimateTokens(JSON.stringify(items)) };
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

export function renderContext(data: Awaited<ReturnType<typeof buildContext>>): string {
  return `Context pack: ${data.usedTokens} tokens, ${data.items.length} included\n\n${data.items.map((item, index) => `${index + 1}. ${item.path} ${item.type} (${item.reason})`).join('\n')}\n\nNext reads:\n${data.nextReads.map((item) => `  codebone ${item.command} ${item.path}`).join('\n')}`;
}
