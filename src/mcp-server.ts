import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildContext, renderContext } from './core/context.js';
import { doctor, renderDoctor } from './core/doctor.js';
import { analyzeImpact, renderImpact } from './core/impact.js';
import { buildIndex, indexStatus, renderIndex } from './core/indexer.js';
import { projectMap, renderMap } from './core/map.js';
import { readCode, renderRead } from './core/reader.js';
import { skeletonDirectory, renderDirectorySkeleton } from './core/directory-skeleton.js';
import { skeletonPath, renderSkeleton } from './core/skeleton.js';
import { findSymbols, renderSymbols } from './core/symbols.js';
import { runBatch } from './core/batch.js';
import { effectiveConfig, setConfigOverrides } from './utils/config.js';
import { normalizeRoot, decodeResourcePath, resolveInsideRoot } from './utils/paths.js';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { looseOutputSchema, objectSchema } from './mcp/schema.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './core/budget.js';
import { CodeboneError, toCodeboneError } from './utils/errors.js';

type JsonRpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const root = normalizeRoot(readArg('--root') ?? '.');
setConfigOverrides(root, { noCache: readFlag('--no-cache') });

if (process.argv[1]?.endsWith('mcp-server.js') || process.argv.includes('mcp')) {
  startMcpServer();
}

export function startMcpServer(): void {
  installStdoutGuard();
  const server = createSdkServer(root);
  const transport = new StdioServerTransport(process.stdin, createProtocolStdout());
  server.connect(transport).catch((error: unknown) => {
    process.stderr.write(`codebone mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  process.on('SIGTERM', () => {
    void server.close().finally(() => process.exit(0));
  });
  process.stdin.on('close', () => {
    void server.close().finally(() => process.exit(0));
  });
}

export function createSdkServer(projectRoot: string): Server {
  const server = new Server({ name: 'codebone', version: '0.2.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return toolResult(request.params.name, await callTool(projectRoot, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>));
    } catch (error) {
      return toolError(error);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const data = await readResource(projectRoot, uri);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts }));
  server.setRequestHandler(GetPromptRequestSchema, (request) => promptResult(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>));
  return server;
}

// Test harness for MCP request compatibility; runtime uses the official SDK transport above.
export async function handleMcpRequest(projectRoot: string, message: JsonRpc): Promise<Record<string, unknown> | undefined> {
  if (!message.method) return;
  try {
    if (message.method === 'initialize') {
      return { id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'codebone', version: '0.2.0' } } };
    } else if (message.method === 'notifications/initialized') {
      return;
    } else if (message.method === 'tools/list') {
      return { id: message.id, result: { tools } };
    } else if (message.method === 'tools/call') {
      const params = message.params ?? {};
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await callTool(projectRoot, name, args);
        return { id: message.id, result: toolResult(name, data) };
      } catch (error) {
        return { id: message.id, result: toolError(error) };
      }
    } else if (message.method === 'resources/list') {
      return { id: message.id, result: { resources } };
    } else if (message.method === 'resources/read') {
      const uri = String(message.params?.uri ?? '');
      const data = await readResource(projectRoot, uri);
      return { id: message.id, result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] } };
    } else if (message.method === 'prompts/list') {
      return { id: message.id, result: { prompts } };
    } else if (message.method === 'prompts/get') {
      return { id: message.id, result: promptResult(String(message.params?.name ?? ''), (message.params?.arguments ?? {}) as Record<string, unknown>) };
    } else {
      return errorPayload(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return errorPayload(message.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(projectRoot: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  return handleToolCall(projectRoot, name, args);
}

async function handleToolCall(projectRoot: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'codebone_map') return projectMap(projectRoot, String(args.path ?? '.'), { budget: Number(args.budget ?? 1200), limit: optionalNumber(args.limit), offset: optionalNumber(args.offset), maxFiles: optionalNumber(args.maxFiles), maxFileBytes: optionalNumber(args.maxFileBytes), timeoutMs: optionalNumber(args.timeoutMs), ignore: stringList(args.ignore) });
  if (name === 'codebone_skeleton') {
    const target = String(args.path);
    const stat = await fs.stat(resolveInsideRoot(projectRoot, target));
    const mode = args.mode === 'summary' || args.mode === 'public_api' ? args.mode : 'full';
    const detail = ['rpc_api', 'lifecycle', 'app_dependencies', 'public_methods'].includes(String(args.mode)) ? String(args.mode) as 'rpc_api' | 'lifecycle' | 'app_dependencies' | 'public_methods' : undefined;
    if (stat.isDirectory()) return skeletonDirectory(projectRoot, target, { publicOnly: Boolean(args.publicOnly), publicApiOnly: mode === 'public_api', symbolsOnly: Boolean(args.symbolsOnly), includePrivate: Boolean(args.includePrivate), includeRoutes: args.includeRoutes !== false, detail, maxFiles: Number(args.maxFiles ?? 50), maxFileBytes: optionalNumber(args.maxFileBytes), budget: Number(args.budget ?? 12000), changedOnly: Boolean(args.changedOnly), mode, signatures: Boolean(args.signatures) });
    return skeletonPath(projectRoot, target, { publicOnly: Boolean(args.publicOnly), publicApiOnly: mode === 'public_api', symbolsOnly: Boolean(args.symbolsOnly), includePrivate: Boolean(args.includePrivate), includeRoutes: args.includeRoutes !== false, detail, noImports: Boolean(args.noImports) || args.includeImports === false || mode === 'public_api', budget: Number(args.budget ?? 12000), signatures: Boolean(args.signatures), maxFileBytes: optionalNumber(args.maxFileBytes) });
  }
  if (name === 'codebone_symbols') return findSymbols(projectRoot, String(args.path ?? '.'), { query: String(args.query), kind: String(args.kind ?? 'all') as never, exact: args.exact === undefined ? undefined : Boolean(args.exact), fuzzy: Boolean(args.fuzzy), limit: Number(args.limit ?? 100), offset: Number(args.offset ?? 0), includeImports: args.includeImports !== false, walk: { maxFiles: optionalNumber(args.maxFiles), maxFileBytes: optionalNumber(args.maxFileBytes), timeoutMs: optionalNumber(args.timeoutMs), ignore: stringList(args.ignore) } });
  if (name === 'codebone_read') return readCode(projectRoot, String(args.path), { symbolId: args.symbolId as string | undefined, symbol: args.symbol as string | undefined, lines: args.lines as string | undefined, context: Number(args.context ?? 0), maxBytes: Number(args.maxBytes ?? 65536) });
  if (name === 'codebone_context') return buildContext(projectRoot, { goal: String(args.goal), goals: Array.isArray(args.goals) ? args.goals.map(String) : [String(args.goal)], symbols: Array.isArray(args.symbols) ? args.symbols.map(String) : typeof args.symbols === 'string' ? String(args.symbols).split(',') : [], path: String(args.path ?? '.'), budget: Number(args.budget ?? 8000), includeTests: args.includeTests !== false, changedOnly: Boolean(args.changedOnly), mode: ['architecture', 'overview', 'edit_prep', 'composition', 'test_impact'].includes(String(args.mode)) ? String(args.mode) as 'architecture' | 'overview' | 'edit_prep' | 'composition' | 'test_impact' : 'full', productionOnly: Boolean(args.productionOnly), testsOnly: Boolean(args.testsOnly), includeMocks: Boolean(args.includeMocks), includeConfig: Boolean(args.includeConfig), includeMigrations: Boolean(args.includeMigrations), maxFiles: optionalNumber(args.maxFiles), maxFileBytes: optionalNumber(args.maxFileBytes), timeoutMs: optionalNumber(args.timeoutMs), ignore: stringList(args.ignore) });
  if (name === 'codebone_impact') return analyzeImpact(projectRoot, String(args.path), { symbol: args.symbol as string | undefined, symbolId: args.symbolId as string | undefined, lines: args.lines as string | undefined, budget: args.budget === undefined ? undefined : Number(args.budget) });
  if (name === 'codebone_batch') return runBatch(projectRoot, (args.operations ?? []) as Array<Record<string, unknown>>);
  if (name === 'codebone_index') return buildIndex(projectRoot, String(args.path ?? '.'), { clear: Boolean(args.clear) });
  if (name === 'codebone_doctor') return doctor(projectRoot);
  throw new CodeboneError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
}

async function readResource(projectRoot: string, uri: string): Promise<unknown> {
  if (uri === 'codebone://project/map') return projectMap(projectRoot, '.', 1200);
  if (uri === 'codebone://project/index-status') return indexStatus(projectRoot);
  if (uri === 'codebone://config/effective') return { ...(await effectiveConfig(projectRoot)), schemaVersion: 'codebone.v1' };
  const fileMatch = uri.match(/^codebone:\/\/file\/(.+)\/skeleton$/);
  if (fileMatch) return skeletonPath(projectRoot, decodeResourcePath(fileMatch[1]));
  const symbolMatch = uri.match(/^codebone:\/\/symbol\/(.+)$/);
  if (symbolMatch) {
    const symbolId = decodeResourcePath(symbolMatch[1]);
    const file = symbolId.split('#')[0];
    return readCode(projectRoot, file, { symbolId });
  }
  throw new Error(`Unknown resource: ${uri}`);
}

function toolResult(name: string, data: unknown) {
  const structuredContent = wrapStructuredContent(data);
  return {
    structuredContent,
    content: [{ type: 'text', text: truncateText(renderToolText(name, data), 12000) }],
    isError: false,
  };
}

function toolError(error: unknown) {
  const typed = toCodeboneError(error);
  const message = typed.message;
  return {
    structuredContent: { schemaVersion: 'codebone.v1', error: typed.code, message, data: typed.details },
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function wrapStructuredContent(data: unknown) {
  const value = data as Record<string, unknown>;
  return {
    schemaVersion: 'codebone.v1',
    data,
    warnings: Array.isArray(value?.warnings) ? value.warnings : [],
    truncated: Boolean(value?.truncated),
    tokenEstimate: typeof value?.tokenEstimate === 'number' ? value.tokenEstimate : estimateTokens(JSON.stringify(data)),
    tokenEstimator: TOKEN_ESTIMATOR,
  };
}

function renderToolText(name: string, data: unknown): string {
  switch (name) {
    case 'codebone_map': return renderMap(data as Awaited<ReturnType<typeof projectMap>>);
    case 'codebone_skeleton': return Array.isArray((data as { skeletons?: unknown[] }).skeletons) ? renderDirectorySkeleton(data as Awaited<ReturnType<typeof skeletonDirectory>>) : renderSkeleton(data as Awaited<ReturnType<typeof skeletonPath>>);
    case 'codebone_symbols': return renderSymbols(data as Awaited<ReturnType<typeof findSymbols>>);
    case 'codebone_read': return renderRead(data as Awaited<ReturnType<typeof readCode>>);
    case 'codebone_context': return renderContext(data as Awaited<ReturnType<typeof buildContext>>);
    case 'codebone_impact': return renderImpact(data as Awaited<ReturnType<typeof analyzeImpact>>);
    case 'codebone_index': return renderIndex(data as Awaited<ReturnType<typeof buildIndex>>);
    case 'codebone_doctor': return renderDoctor(data as Awaited<ReturnType<typeof doctor>>);
    default: return JSON.stringify(data, null, 2);
  }
}

function truncateText(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept, line, '[truncated]'].join('\n');
    if (estimateTokens(next) > budget) break;
    kept.push(line);
  }
  return `${kept.join('\n')}\n[truncated]`;
}

function installStdoutGuard(): void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const redirect = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(' ')}\n`);
  console.log = redirect;
  console.info = redirect;
  console.debug = redirect;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    process.stderr.write(text);
    if (typeof encodingOrCallback === 'function') encodingOrCallback();
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;
  (process.stdout as unknown as { writeRaw: typeof process.stdout.write }).writeRaw = originalWrite;
}

function createProtocolStdout(): Writable {
  const originalWrite = (process.stdout as unknown as { writeRaw?: typeof process.stdout.write }).writeRaw ?? process.stdout.write.bind(process.stdout);
  return new Writable({
    write(chunk, encoding, callback) {
      originalWrite(chunk, encoding as BufferEncoding, callback);
    },
  });
}

function errorPayload(id: JsonRpc['id'], code: number, message: string): Record<string, unknown> {
  return { id, error: { code, message } };
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}

const tools = [
  { name: 'codebone_map', description: 'Get a compact project map for orientation. Use before broad exploration; do not use for symbol bodies, use codebone_read instead.', inputSchema: schema({ path: 'string', budget: 'integer', limit: 'integer', offset: 'integer', maxFiles: 'integer', maxFileBytes: 'integer', timeoutMs: 'integer', ignore: 'array' }), outputSchema: outputSchema() },
  { name: 'codebone_skeleton', description: 'Get structural symbols for a file or directory. Use to inspect shape; do not use for exact bodies, use codebone_read instead.', inputSchema: schema({ path: 'string', publicOnly: 'boolean', maxFiles: 'integer', maxFileBytes: 'integer', budget: 'integer', changedOnly: 'boolean', mode: 'string', symbolsOnly: 'boolean', includeImports: 'boolean', includePrivate: 'boolean', includeRoutes: 'boolean', signatures: 'boolean' }, ['path']), outputSchema: outputSchema() },
  { name: 'codebone_symbols', description: 'Find definitions and references by symbol name. Use to locate code; do not use for full task packs, use codebone_context instead.', inputSchema: schema({ query: 'string', path: 'string', kind: 'string', exact: 'boolean', fuzzy: 'boolean', limit: 'integer', offset: 'integer', includeImports: 'boolean', maxFiles: 'integer', maxFileBytes: 'integer', timeoutMs: 'integer', ignore: 'array' }, ['query']), outputSchema: outputSchema() },
  { name: 'codebone_read', description: 'Read one exact symbol body or line range. Use after map/symbols; do not use for repository overview, use codebone_map first.', inputSchema: schema({ path: 'string', symbolId: 'string', symbol: 'string', lines: 'string', context: 'integer', maxBytes: 'integer' }, ['path']), outputSchema: outputSchema() },
  { name: 'codebone_context', description: 'Build a budgeted task-focused context pack with suggested next reads. Use for task planning; do not use to inspect a single exact body, use codebone_read.', inputSchema: schema({ goal: 'string', goals: 'array', symbols: 'array', path: 'string', budget: 'integer', includeTests: 'boolean', changedOnly: 'boolean', mode: 'string', productionOnly: 'boolean', testsOnly: 'boolean', includeMocks: 'boolean', includeConfig: 'boolean', includeMigrations: 'boolean', maxFiles: 'integer', maxFileBytes: 'integer', timeoutMs: 'integer', ignore: 'array' }, ['goal']), outputSchema: outputSchema() },
  { name: 'codebone_batch', description: 'Execute multiple read-only codebone operations in order. Use to reduce round-trips; do not use to bypass budgets.', inputSchema: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['operations'], additionalProperties: true }, outputSchema: outputSchema() },
  { name: 'codebone_index', description: 'Build or update the optional local symbol index. Use for faster repeated lookups; do not use when strict no-write operation is required.', inputSchema: schema({ path: 'string', clear: 'boolean' }), outputSchema: outputSchema() },
  { name: 'codebone_doctor', description: 'Diagnose parser, config, cache, limits, and repository context quality. Use for setup checks; do not use for code reading.', inputSchema: schema({}), outputSchema: outputSchema() },
  { name: 'codebone_impact', description: 'Analyze likely affected files, references, imports, relationships, and tests before editing a file, symbol, or line range. Use when planning a change; do not use for reading symbol bodies, use codebone_read instead.', inputSchema: schema({ path: 'string', symbol: 'string', symbolId: 'string', lines: 'string', budget: 'integer' }, ['path']), outputSchema: outputSchema() },
];

const resources = [
  { uri: 'codebone://project/map', name: 'Project map', mimeType: 'application/json' },
  { uri: 'codebone://project/index-status', name: 'Index status', mimeType: 'application/json' },
  { uri: 'codebone://file/{encodedPath}/skeleton', name: 'File skeleton template', mimeType: 'application/json' },
  { uri: 'codebone://symbol/{encodedSymbolId}', name: 'Symbol body template', mimeType: 'application/json' },
  { uri: 'codebone://config/effective', name: 'Effective config', mimeType: 'application/json' },
];

const prompts = [
  { name: 'codebone_explore_before_edit', description: 'Collect context pack before editing.', arguments: [{ name: 'goal', required: true }, { name: 'budget', required: false }] },
  { name: 'codebone_review_symbol', description: 'Review one symbol and nearby references.', arguments: [{ name: 'symbolId', required: false }, { name: 'path', required: false }, { name: 'symbol', required: false }] },
  { name: 'codebone_find_related_tests', description: 'Find tests related to a path or symbol.', arguments: [{ name: 'path', required: false }, { name: 'symbolId', required: false }] },
];

function schema(properties: Record<string, string>, required: string[] = []) {
  return objectSchema(properties, required);
}

function outputSchema() {
  return looseOutputSchema();
}

function promptResult(name: string, args: Record<string, unknown>) {
  const goal = String(args.goal ?? 'the requested change');
  const text = name === 'codebone_explore_before_edit'
    ? `Use codebone_context with goal "${goal}" and budget ${args.budget ?? 8000}. Then call codebone_skeleton or codebone_read only for selected files and symbols before editing.`
      : name === 'codebone_review_symbol'
        ? `Call codebone_read for ${args.symbolId ? `symbolId "${args.symbolId}"` : args.path ? `path "${args.path}"${args.symbol ? ` and symbol "${args.symbol}"` : ''}` : 'the target symbol'}, then codebone_symbols for its name to inspect definitions and references.`
      : `Find tests related to ${args.symbolId ? `symbolId "${args.symbolId}"` : args.path ? `path "${args.path}"` : 'the target'}. Call codebone_symbols and codebone_context with includeTests enabled, prioritizing test/spec paths near the target.`;
  return { description: name, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
