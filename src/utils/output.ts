import { Envelope, SCHEMA_VERSION } from '../types.js';
import { estimateTokens } from '../core/budget.js';

export function envelope<T>(root: string, request: Record<string, unknown>, data: T, startedAt: number): Envelope<T> {
  const value = data as Record<string, unknown>;
  return {
    schemaVersion: SCHEMA_VERSION,
    root,
    request,
    data,
    warnings: Array.isArray(value.warnings) ? value.warnings as string[] : [],
    truncated: Boolean(value.truncated),
    tokenEstimate: typeof value.tokenEstimate === 'number' ? value.tokenEstimate : estimateTokens(JSON.stringify(data)),
    elapsedMs: Date.now() - startedAt,
  };
}

export function printResult<T>(format: 'text' | 'json', text: string, json: T): void {
  if (format === 'json') process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}
