import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildContext, renderContext } from './core/context.js';
import { doctor, renderDoctor } from './core/doctor.js';
import { buildIndex, indexStatus, renderIndex } from './core/indexer.js';
import { projectMap, renderMap } from './core/map.js';
import { readCode, renderRead } from './core/reader.js';
import { skeletonDirectory, renderDirectorySkeleton } from './core/directory-skeleton.js';
import { skeletonPath, renderSkeleton } from './core/skeleton.js';
import { findSymbols, renderSymbols } from './core/symbols.js';
import { runBatch } from './core/batch.js';
import { effectiveConfig } from './utils/config.js';
import { normalizeRoot, decodeResourcePath, resolveInsideRoot } from './utils/paths.js';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { looseOutputSchema, objectSchema } from './mcp/schema.js';
import { estimateTokens } from './core/budget.js';

type JsonRpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const root = normalizeRoot(readArg('--root') ?? '.');

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
  const server = new Server({ name: 'codebone', version: '0.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
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
      return { id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'codebone', version: '0.1.0' } } };
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
  if (name === 'codebone_map') return projectMap(projectRoot, String(args.path ?? '.'), Number(args.budget ?? 1200));
  if (name === 'codebone_skeleton') {
    const target = String(args.path);
    const stat = await fs.stat(resolveInsideRoot(projectRoot, target));
    if (stat.isDirectory()) return skeletonDirectory(projectRoot, target, { publicOnly: Boolean(args.publicOnly), maxFiles: Number(args.maxFiles ?? 50), budget: Number(args.budget ?? 12000), changedOnly: Boolean(args.changedOnly) });
    return skeletonPath(projectRoot, target, { publicOnly: Boolean(args.publicOnly), noImports: Boolean(args.noImports), budget: Number(args.budget ?? 12000) });
  }
  if (name === 'codebone_symbols') return findSymbols(projectRoot, String(args.path ?? '.'), { query: String(args.query), kind: String(args.kind ?? 'all') as never, exact: args.exact === undefined ? undefined : Boolean(args.exact), fuzzy: Boolean(args.fuzzy), limit: Number(args.limit ?? 100), includeImports: args.includeImports !== false });
  if (name === 'codebone_read') return readCode(projectRoot, String(args.path), { symbolId: args.symbolId as string | undefined, symbol: args.symbol as string | undefined, lines: args.lines as string | undefined, context: Number(args.context ?? 0), maxBytes: Number(args.maxBytes ?? 65536) });
  if (name === 'codebone_context') return buildContext(projectRoot, { goal: String(args.goal), path: String(args.path ?? '.'), budget: Number(args.budget ?? 8000), includeTests: args.includeTests !== false, changedOnly: Boolean(args.changedOnly) });
  if (name === 'codebone_batch') return runBatch(projectRoot, (args.operations ?? []) as Array<Record<string, unknown>>);
  if (name === 'codebone_index') return buildIndex(projectRoot, String(args.path ?? '.'), { clear: Boolean(args.clear) });
  if (name === 'codebone_doctor') return doctor(projectRoot);
  throw new Error(`Unknown tool: ${name}`);
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
  const message = error instanceof Error ? error.message : String(error);
  return {
    structuredContent: { schemaVersion: 'codebone.v1', error: message },
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
  };
}

function renderToolText(name: string, data: unknown): string {
  switch (name) {
    case 'codebone_map': return renderMap(data as Awaited<ReturnType<typeof projectMap>>);
    case 'codebone_skeleton': return Array.isArray((data as { skeletons?: unknown[] }).skeletons) ? renderDirectorySkeleton(data as Awaited<ReturnType<typeof skeletonDirectory>>) : renderSkeleton(data as Awaited<ReturnType<typeof skeletonPath>>);
    case 'codebone_symbols': return renderSymbols(data as Awaited<ReturnType<typeof findSymbols>>);
    case 'codebone_read': return renderRead(data as Awaited<ReturnType<typeof readCode>>);
    case 'codebone_context': return renderContext(data as Awaited<ReturnType<typeof buildContext>>);
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

const tools = [
  { name: 'codebone_map', description: 'Get a compact project map: languages, entrypoints, top directories, index status, and suggested first reads.', inputSchema: schema({ path: 'string', budget: 'integer' }), outputSchema: outputSchema() },
  { name: 'codebone_skeleton', description: 'Get the structural skeleton of a source file or directory: all function signatures, class definitions, imports, and type declarations with line numbers. Bodies of functions are omitted. Use this INSTEAD of reading entire files to save context. Then use codebone_read to get specific function bodies you need.', inputSchema: schema({ path: 'string', publicOnly: 'boolean', maxFiles: 'integer', budget: 'integer', changedOnly: 'boolean' }, ['path']), outputSchema: outputSchema() },
  { name: 'codebone_symbols', description: 'Search for a symbol (function, class, variable, type) by name across the entire project. Returns definitions and references with file paths and line numbers. Use this to find where something is defined or used.', inputSchema: schema({ query: 'string', path: 'string', kind: 'string', exact: 'boolean', fuzzy: 'boolean', limit: 'integer', includeImports: 'boolean' }, ['query']), outputSchema: outputSchema() },
  { name: 'codebone_read', description: 'Read a specific symbol body or line range. Prefer symbolId from codebone_skeleton or codebone_symbols over fuzzy symbol names.', inputSchema: schema({ path: 'string', symbolId: 'string', symbol: 'string', lines: 'string', context: 'integer', maxBytes: 'integer' }, ['path']), outputSchema: outputSchema() },
  { name: 'codebone_context', description: 'Build a ranked context pack for a concrete coding task under a token budget. Use before editing when you need to understand related files.', inputSchema: schema({ goal: 'string', path: 'string', budget: 'integer', includeTests: 'boolean', changedOnly: 'boolean' }, ['goal']), outputSchema: outputSchema() },
  { name: 'codebone_batch', description: 'Execute multiple read-only codebone operations in one call. Use to minimize round-trips when you need several skeleton/read/symbol/context results.', inputSchema: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object' } } }, required: ['operations'], additionalProperties: false }, outputSchema: outputSchema() },
  { name: 'codebone_index', description: 'Build or update the local project symbol index for faster searches and context packs.', inputSchema: schema({ path: 'string', clear: 'boolean' }), outputSchema: outputSchema() },
  { name: 'codebone_doctor', description: 'Check codebone installation, parser availability, index writability, and MCP stdio readiness.', inputSchema: schema({}), outputSchema: outputSchema() },
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
