import fs from 'node:fs/promises';
import { SCHEMA_VERSION } from '../types.js';
import { loadConfig } from '../utils/config.js';
import { CodeboneError, toCodeboneError } from '../utils/errors.js';
import { resolveInsideRoot } from '../utils/paths.js';
import { estimateTokens } from './budget.js';
import { buildContext } from './context.js';
import { doctor } from './doctor.js';
import { analyzeImpact } from './impact.js';
import { buildIndex } from './indexer.js';
import { projectMap } from './map.js';
import { readCode } from './reader.js';
import { skeletonDirectory } from './directory-skeleton.js';
import { skeletonPath } from './skeleton.js';
import { findSymbols } from './symbols.js';

export async function runBatch(root: string, operations: Array<Record<string, unknown>>) {
  const batchStartedAt = Date.now();
  const config = await loadConfig(root);
  const requestedBudget = operations.reduce((sum, operation) => sum + budgetForOperation(operation), 0);
  if (requestedBudget > config.batchBudget) throw new CodeboneError('LIMIT_EXCEEDED', `batch requested budget ${requestedBudget} exceeds batchBudget ${config.batchBudget}`);
  const results = [];
  for (const operation of operations) {
    const startedAt = Date.now();
    const op = normalizeBatchOp(operation);
    const base = { schemaVersion: SCHEMA_VERSION, op, path: operation.path };
    try {
      if (!isBatchOp(op)) throw new CodeboneError('UNKNOWN_TOOL', batchOpError(operation));
      if (op === 'map') results.push(withElapsed({ ...base, success: true, data: await projectMap(root, String(operation.path ?? '.'), { budget: Number(operation.budget ?? 1200), limit: optionalNumber(operation.limit), offset: optionalNumber(operation.offset), maxFiles: optionalNumber(operation.maxFiles), maxFileBytes: optionalNumber(operation.maxFileBytes), timeoutMs: optionalNumber(operation.timeoutMs), ignore: stringList(operation.ignore) }) }, startedAt));
      else if (op === 'skeleton') results.push(withElapsed({ ...base, success: true, data: await runSkeletonOperation(root, operation) }, startedAt));
      else if (op === 'symbols') results.push(withElapsed({ ...base, success: true, data: await findSymbols(root, String(operation.path ?? '.'), { query: String(operation.query ?? ''), kind: String(operation.kind ?? 'all') as never, exact: optionalBoolean(operation.exact), fuzzy: Boolean(operation.fuzzy), limit: optionalNumber(operation.limit), offset: optionalNumber(operation.offset), includeImports: operation.includeImports !== false, walk: { maxFiles: optionalNumber(operation.maxFiles), maxFileBytes: optionalNumber(operation.maxFileBytes), timeoutMs: optionalNumber(operation.timeoutMs), ignore: stringList(operation.ignore) } }) }, startedAt));
      else if (op === 'read') results.push(withElapsed({ ...base, success: true, data: await readCode(root, String(operation.path ?? ''), { symbolId: operation.symbolId as string | undefined, symbol: operation.symbol as string | undefined, lines: operation.lines as string | undefined, context: optionalNumber(operation.context), maxBytes: optionalNumber(operation.maxBytes) }) }, startedAt));
      else if (op === 'context' || op === 'test_impact') results.push(withElapsed({ schemaVersion: SCHEMA_VERSION, op, path: operation.path, success: true, data: await buildContext(root, contextOptionsForOperation(operation, op)) }, startedAt));
      else if (op === 'index') results.push(withElapsed({ ...base, success: true, data: await buildIndex(root, String(operation.path ?? '.'), { clear: Boolean(operation.clear) }) }, startedAt));
      else if (op === 'impact') results.push(withElapsed({ ...base, success: true, data: await analyzeImpact(root, String(operation.path ?? ''), { symbol: operation.symbol as string | undefined, symbolId: operation.symbolId as string | undefined, lines: operation.lines as string | undefined, budget: operation.budget ? Number(operation.budget) : undefined }) }, startedAt));
      else if (op === 'doctor') results.push(withElapsed({ ...base, success: true, data: await doctor(root) }, startedAt));
    } catch (error) {
      const typed = toCodeboneError(error);
      results.push(withElapsed({
        ...base,
        success: false,
        error: typed.message,
        errorCode: typed.code,
        errorDetails: typed.details,
        structuredError: { code: typed.code, message: typed.message, details: typed.details },
      }, startedAt));
    }
  }
  const text = JSON.stringify(results);
  return { schemaVersion: SCHEMA_VERSION, results, warnings: [], truncated: false, tokenEstimate: estimateTokens(text), elapsedMs: Date.now() - batchStartedAt };
}

function normalizeBatchOp(operation: Record<string, unknown>): string {
  if (operation.op) return String(operation.op);
  if (operation.tool) return String(operation.tool).replace(/^codebone_/, '');
  if (operation.name) return String(operation.name).replace(/^codebone_/, '');
  return '';
}

function batchOpError(operation: Record<string, unknown>): string {
  const received = operation.op ?? operation.tool ?? operation.name ?? '';
  return `Unsupported batch op: ${JSON.stringify(received)}. Expected operation shape like {"op":"skeleton","path":"src/app.py","mode":"public_api"}. Allowed ops: ${[...batchOps].join(', ')}. If you used "tool", use "op" or a codebone_* tool name.`;
}

const batchOps = new Set(['map', 'skeleton', 'symbols', 'read', 'context', 'test_impact', 'index', 'impact', 'doctor']);

function isBatchOp(op: string): op is 'map' | 'skeleton' | 'symbols' | 'read' | 'context' | 'test_impact' | 'index' | 'impact' | 'doctor' {
  return batchOps.has(op);
}

function budgetForOperation(operation: Record<string, unknown>): number {
  const op = normalizeBatchOp(operation);
  if (op === 'context' || op === 'test_impact') return Number(operation.budget ?? 8000);
  if (op === 'impact') return Number(operation.budget ?? 6000);
  if (op === 'skeleton') return Number(operation.budget ?? 12000);
  if (op === 'map') return Number(operation.budget ?? 1200);
  return 0;
}

function withElapsed<T extends Record<string, unknown>>(result: T, startedAt: number): T & { elapsedMs: number } {
  return { ...result, elapsedMs: Date.now() - startedAt };
}

async function runSkeletonOperation(root: string, operation: Record<string, unknown>) {
  const target = String(operation.path ?? '.');
  const mode = operation.mode === 'summary' || operation.mode === 'public_api' ? operation.mode : 'full';
  const detail = ['rpc_api', 'lifecycle', 'app_dependencies', 'public_methods'].includes(String(operation.mode)) ? String(operation.mode) as 'rpc_api' | 'lifecycle' | 'app_dependencies' | 'public_methods' : undefined;
  const stat = await fs.stat(resolveInsideRoot(root, target));
  if (stat.isDirectory()) {
    return skeletonDirectory(root, target, {
      publicOnly: Boolean(operation.publicOnly),
      publicApiOnly: mode === 'public_api' || Boolean(operation.publicApiOnly),
      symbolsOnly: Boolean(operation.symbolsOnly),
      includePrivate: Boolean(operation.includePrivate),
      includeRoutes: operation.includeRoutes !== false,
      detail,
      maxFiles: optionalNumber(operation.maxFiles),
      maxFileBytes: optionalNumber(operation.maxFileBytes),
      budget: optionalNumber(operation.budget),
      changedOnly: Boolean(operation.changedOnly),
      mode,
      signatures: Boolean(operation.signatures),
    });
  }
  return skeletonPath(root, target, {
    publicOnly: Boolean(operation.publicOnly),
    publicApiOnly: mode === 'public_api' || Boolean(operation.publicApiOnly),
    symbolsOnly: Boolean(operation.symbolsOnly),
    includePrivate: Boolean(operation.includePrivate),
    includeRoutes: operation.includeRoutes !== false,
    detail,
    noImports: operation.includeImports === false || Boolean(operation.noImports) || mode === 'public_api',
    budget: optionalNumber(operation.budget),
    maxFileBytes: optionalNumber(operation.maxFileBytes),
    signatures: Boolean(operation.signatures),
  });
}

function contextOptionsForOperation(operation: Record<string, unknown>, op: 'context' | 'test_impact') {
  return {
    goal: String(operation.goal ?? (op === 'test_impact' ? 'find related tests' : 'understand project')),
    goals: stringList(operation.goals),
    symbols: stringList(operation.symbols),
    path: operation.path as string | undefined,
    budget: optionalNumber(operation.budget),
    includeTests: optionalBoolean(operation.includeTests),
    changedOnly: optionalBoolean(operation.changedOnly),
    mode: op === 'test_impact' ? 'test_impact' as const : contextMode(operation.mode),
    productionOnly: Boolean(operation.productionOnly),
    testsOnly: Boolean(operation.testsOnly),
    includeMocks: Boolean(operation.includeMocks),
    includeConfig: Boolean(operation.includeConfig),
    includeMigrations: Boolean(operation.includeMigrations),
    maxFiles: optionalNumber(operation.maxFiles),
    maxFileBytes: optionalNumber(operation.maxFileBytes),
    timeoutMs: optionalNumber(operation.timeoutMs),
    ignore: stringList(operation.ignore),
  };
}

function contextMode(value: unknown): 'full' | 'architecture' | 'overview' | 'edit_prep' | 'composition' | 'test_impact' {
  const mode = String(value ?? 'full');
  return ['architecture', 'overview', 'edit_prep', 'composition', 'test_impact'].includes(mode) ? mode as 'architecture' | 'overview' | 'edit_prep' | 'composition' | 'test_impact' : 'full';
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : Boolean(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}
