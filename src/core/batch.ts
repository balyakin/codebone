import { SCHEMA_VERSION } from '../types.js';
import { estimateTokens } from './budget.js';
import { buildContext } from './context.js';
import { buildIndex } from './indexer.js';
import { projectMap } from './map.js';
import { readCode } from './reader.js';
import { skeletonPath } from './skeleton.js';
import { findSymbols } from './symbols.js';

export async function runBatch(root: string, operations: Array<Record<string, unknown>>) {
  const batchStartedAt = Date.now();
  const results = [];
  for (const operation of operations) {
    const startedAt = Date.now();
    const op = String(operation.op ?? '');
    const base = { schemaVersion: SCHEMA_VERSION, op, path: operation.path };
    try {
      if (!isBatchOp(op)) throw new Error(`Unsupported op: ${op}`);
      if (op === 'map') results.push(withElapsed({ ...base, success: true, data: await projectMap(root, String(operation.path ?? '.'), Number(operation.budget ?? 1200)) }, startedAt));
      else if (op === 'skeleton') results.push(withElapsed({ ...base, success: true, data: await skeletonPath(root, String(operation.path ?? '.'), { publicOnly: Boolean(operation.publicOnly), noImports: Boolean(operation.noImports), budget: operation.budget ? Number(operation.budget) : undefined }) }, startedAt));
      else if (op === 'symbols') results.push(withElapsed({ ...base, success: true, data: await findSymbols(root, String(operation.path ?? '.'), { query: String(operation.query ?? ''), kind: String(operation.kind ?? 'all') as never, limit: operation.limit ? Number(operation.limit) : undefined, includeImports: operation.includeImports !== false }) }, startedAt));
      else if (op === 'read') results.push(withElapsed({ ...base, success: true, data: await readCode(root, String(operation.path ?? ''), { symbolId: operation.symbolId as string | undefined, symbol: operation.symbol as string | undefined, lines: operation.lines as string | undefined }) }, startedAt));
      else if (op === 'context') results.push(withElapsed({ schemaVersion: SCHEMA_VERSION, op, success: true, data: await buildContext(root, { goal: String(operation.goal ?? ''), path: operation.path as string | undefined, budget: operation.budget ? Number(operation.budget) : undefined }) }, startedAt));
      else if (op === 'index') results.push(withElapsed({ ...base, success: true, data: await buildIndex(root, String(operation.path ?? '.'), { clear: Boolean(operation.clear) }) }, startedAt));
    } catch (error) {
      results.push(withElapsed({ ...base, success: false, error: error instanceof Error ? error.message : String(error) }, startedAt));
    }
  }
  const text = JSON.stringify(results);
  return { schemaVersion: SCHEMA_VERSION, results, warnings: [], truncated: false, tokenEstimate: estimateTokens(text), elapsedMs: Date.now() - batchStartedAt };
}

const batchOps = new Set(['map', 'skeleton', 'symbols', 'read', 'context', 'index']);

function isBatchOp(op: string): op is 'map' | 'skeleton' | 'symbols' | 'read' | 'context' | 'index' {
  return batchOps.has(op);
}

function withElapsed<T extends Record<string, unknown>>(result: T, startedAt: number): T & { elapsedMs: number } {
  return { ...result, elapsedMs: Date.now() - startedAt };
}
