import { SCHEMA_VERSION } from '../types.js';
import { resolveInsideRoot, toRelative } from '../utils/paths.js';
import { readTextFileSafe } from '../utils/security.js';
import { estimateTokens } from './budget.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

export interface ReadOptions {
  symbolId?: string;
  symbol?: string;
  lines?: string;
  context?: number;
  maxBytes?: number;
}

export async function readCode(root: string, inputPath: string, options: ReadOptions) {
  const absolutePath = resolveInsideRoot(root, inputPath);
  const maxBytes = options.maxBytes ?? 65536;
  const { text: source } = await readTextFileSafe(absolutePath, maxBytes, root);
  const relativePath = toRelative(root, absolutePath);
  const allLines = source.split(/\r?\n/);
  const warnings: string[] = [];
  let startLine = 1;
  let endLine = allLines.length;
  let label = relativePath;
  let symbolId: string | undefined;

  if (options.lines) {
    const match = options.lines.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error('Invalid --lines format, expected start:end');
    startLine = Number(match[1]);
    endLine = Number(match[2]);
    if (startLine < 1 || endLine < startLine || endLine > allLines.length) throw new Error(`Invalid line range: ${options.lines}`);
    label = `${relativePath}:${startLine}..${endLine}`;
  } else {
    if (!options.symbolId && !options.symbol) throw new Error('Either --symbol-id, --symbol, or --lines is required');
    const skeleton = await skeletonSourceAsync(root, relativePath, source);
    const symbols = flattenSymbols(skeleton.symbols);
    const parsedId = options.symbolId ? parseSymbolId(options.symbolId) : undefined;
    if (options.symbolId && !parsedId) throw new Error('Invalid symbolId format');
    if (parsedId && parsedId.file !== relativePath) throw new Error(`symbolId path does not match requested file: ${parsedId.file}`);
    const match = parsedId
      ? symbols.find((item) => item.symbolId === options.symbolId && item.startLine === parsedId.startLine && item.startColumn === parsedId.startColumn && item.endLine === parsedId.endLine && item.endColumn === parsedId.endColumn && item.contentHash === parsedId.contentHash)
        ?? symbols.find((item) => item.kind === parsedId.kind && item.name === symbolName(parsedId.qualifiedName) && item.qualifiedName === parsedId.qualifiedName)
      : symbols.find((item) => item.qualifiedName === options.symbol || item.name === options.symbol);
    if (!match) {
      const query = options.symbol ?? parsedId?.qualifiedName ?? options.symbolId ?? '';
      const suggestions = symbols
        .map((item) => ({ item, score: similarity(query, item.qualifiedName) }))
        .sort((a, b) => b.score - a.score || a.item.startLine - b.item.startLine)
        .slice(0, 8)
        .map(({ item }) => `${item.qualifiedName} (line ${item.startLine})`);
      throw new Error(`Symbol "${query}" not found in ${relativePath}${suggestions.length ? `\nDid you mean:\n${suggestions.join('\n')}` : ''}`);
    }
    if (parsedId && match.symbolId !== options.symbolId) warnings.push('symbol_id_recovered');
    startLine = match.startLine;
    endLine = match.endLine;
    label = `${relativePath}:${startLine}..${endLine} - ${match.kind} ${match.qualifiedName}`;
    symbolId = match.symbolId;
  }

  const context = Math.max(0, options.context ?? 0);
  startLine = Math.max(1, startLine - context);
  endLine = Math.min(allLines.length, endLine + context);
  const fragmentLines = allLines.slice(startLine - 1, endLine);
  let content = fragmentLines.map((line, index) => `${String(startLine + index).padStart(4)} | ${line}`).join('\n');
  let truncated = false;
  if (Buffer.byteLength(content) > maxBytes) {
    content = truncateUtf8(content, maxBytes);
    truncated = true;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    file: relativePath,
    label,
    symbolId,
    startLine,
    endLine,
    content,
    text: content,
    warnings,
    truncated,
    tokenEstimate: estimateTokens(content),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const next = bytes + Buffer.byteLength(char);
    if (next > maxBytes) break;
    bytes = next;
    end += char.length;
  }
  return value.slice(0, end);
}

function parseSymbolId(symbolId: string): { file: string; kind: string; qualifiedName: string; startLine: number; startColumn: number; endLine: number; endColumn: number; contentHash: string } | undefined {
  const match = symbolId.match(/^(.+)#([^:]+):(.+)@(\d+):(\d+)-(\d+):(\d+):([0-9a-f]{8})$/);
  return match ? { file: match[1], kind: match[2], qualifiedName: match[3], startLine: Number(match[4]), startColumn: Number(match[5]), endLine: Number(match[6]), endColumn: Number(match[7]), contentHash: match[8] } : undefined;
}

function symbolName(qualifiedName: string): string {
  return qualifiedName.split('.').pop() ?? qualifiedName;
}

function similarity(query: string, candidate: string): number {
  const a = query.toLowerCase();
  const b = candidate.toLowerCase();
  const distance = levenshtein(a, b);
  const containsBoost = b.includes(a) || a.includes(b) ? 5 : 0;
  return -distance + containsBoost;
}

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length][b.length];
}

export function renderRead(data: Awaited<ReturnType<typeof readCode>>): string {
  return `${data.label}\n\n${data.content}`;
}
