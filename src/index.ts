import fs from 'node:fs/promises';
import { Command } from 'commander';
import { runBatch } from './core/batch.js';
import { buildContext, renderContext } from './core/context.js';
import { skeletonDirectory, renderDirectorySkeleton } from './core/directory-skeleton.js';
import { doctor, renderDoctor } from './core/doctor.js';
import { buildIndex, renderIndex } from './core/indexer.js';
import { projectMap, renderMap } from './core/map.js';
import { readCode, renderRead } from './core/reader.js';
import { renderSkeleton, skeletonPath } from './core/skeleton.js';
import { findSymbols, renderSymbols } from './core/symbols.js';
import { setConfigPath } from './utils/config.js';
import { printResult, envelope } from './utils/output.js';
import { normalizeRoot, resolveInsideRoot } from './utils/paths.js';

const program = new Command();

program
  .name('codebone')
  .description('Agent-native CLI and MCP server for compact code context')
  .version('0.1.2')
  .option('--root <path>', 'project root', '.')
  .option('--format <format>', 'text or json', 'text')
  .option('--budget <tokens>', 'token budget')
  .option('--config <path>', 'path to .codebone.json')
  .option('--quiet', 'suppress stderr logs')
  .option('--verbose', 'verbose diagnostics');

program.command('map')
  .argument('[directory]', 'directory', '.')
  .option('--budget <tokens>', 'token budget', '1200')
  .action(async (directory, options) => run('map', async (root, format, startedAt) => {
    const data = await projectMap(root, directory, Number(options.budget));
    printResult(format, renderMap(data), envelope(root, { command: 'map', path: directory }, data, startedAt));
  }));

program.command('skeleton')
  .argument('<path>', 'file or directory')
  .option('--public-only', 'only public/exported symbols')
  .option('--no-imports', 'hide imports')
  .option('--symbols-only', 'hide imports, constants, variables, and properties')
  .option('--include-private', 'include private Python members in filtered modes')
  .option('--no-include-routes', 'hide route symbols')
  .option('--max-depth <n>', 'maximum nesting depth')
  .option('--max-files <n>', 'max files for directory', '100')
  .option('--include <glob...>', 'include glob')
  .option('--exclude <glob...>', 'exclude glob')
  .option('--changed', 'only changed files')
  .option('--no-respect-ai-ignore', 'do not read .aiignore/.codeboneignore')
  .option('--sort <mode>', 'path, size, relevance, changed', 'path')
  .option('--mode <mode>', 'full or summary', 'full')
  .action(async (inputPath, options) => run('skeleton', async (root, format, startedAt, globals) => {
    const absolutePath = resolveInsideRoot(root, inputPath);
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      const mode = options.mode === 'summary' || options.mode === 'public_api' ? options.mode : 'full';
      const detail = ['rpc_api', 'lifecycle', 'app_dependencies', 'public_methods'].includes(options.mode) ? options.mode : undefined;
      const data = await skeletonDirectory(root, inputPath, { publicOnly: Boolean(options.publicOnly), publicApiOnly: mode === 'public_api', symbolsOnly: Boolean(options.symbolsOnly), includePrivate: Boolean(options.includePrivate), includeRoutes: options.includeRoutes !== false, detail, maxFiles: Number(options.maxFiles), budget: globals.budget ? Number(globals.budget) : 12000, include: options.include, exclude: options.exclude, sort: options.sort, changedOnly: Boolean(options.changed), respectAiIgnore: options.respectAiIgnore, mode });
      printResult(format, renderDirectorySkeleton(data), envelope(root, { command: 'skeleton', path: inputPath }, data, startedAt));
    } else {
      const detail = ['rpc_api', 'lifecycle', 'app_dependencies', 'public_methods'].includes(options.mode) ? options.mode : undefined;
      const data = await skeletonPath(root, inputPath, { publicOnly: Boolean(options.publicOnly), publicApiOnly: options.mode === 'public_api', symbolsOnly: Boolean(options.symbolsOnly), includePrivate: Boolean(options.includePrivate), includeRoutes: options.includeRoutes !== false, detail, noImports: Boolean(options.noImports) || options.mode === 'public_api', budget: globals.budget ? Number(globals.budget) : undefined });
      printResult(format, renderSkeleton(data), envelope(root, { command: 'skeleton', path: inputPath }, data, startedAt));
    }
  }));

program.command('symbols')
  .argument('<path>', 'file or directory')
  .requiredOption('--query <name>', 'symbol name')
  .option('--kind <type>', 'definition, reference, all, export, import', 'all')
  .option('--exact', 'exact symbol matching')
  .option('--fuzzy', 'substring matching')
  .option('--no-use-index', 'do not use an existing index')
  .option('--limit <n>', 'limit', '100')
  .option('--include-imports', 'include import/export edges')
  .action(async (inputPath, options) => run('symbols', async (root, format, startedAt) => {
    const data = await findSymbols(root, inputPath, { query: options.query, kind: options.kind, exact: options.exact, fuzzy: Boolean(options.fuzzy), useIndex: options.useIndex, limit: Number(options.limit), includeImports: options.includeImports !== false });
    printResult(format, renderSymbols(data), envelope(root, { command: 'symbols', path: inputPath, query: options.query }, data, startedAt));
  }));

program.command('read')
  .argument('<path>', 'file')
  .option('--symbol-id <id>', 'symbol id')
  .option('--symbol <name>', 'symbol name')
  .option('--lines <range>', 'start:end')
  .option('--context <n>', 'context lines', '0')
  .option('--max-bytes <n>', 'max bytes', '65536')
  .action(async (inputPath, options) => run('read', async (root, format, startedAt) => {
    const data = await readCode(root, inputPath, { symbolId: options.symbolId, symbol: options.symbol, lines: options.lines, context: Number(options.context), maxBytes: Number(options.maxBytes) });
    printResult(format, renderRead(data), envelope(root, { command: 'read', path: inputPath }, data, startedAt));
  }));

program.command('context')
  .requiredOption('--goal <text>', 'task goal')
  .option('--path <path>', 'directory scope', '.')
  .option('--budget <tokens>', 'token budget', '8000')
  .option('--include-tests', 'include tests')
  .option('--changed-only', 'changed only')
  .option('--mode <mode>', 'full, architecture, overview, edit_prep, or composition', 'full')
  .option('--production-only', 'exclude test files')
  .option('--tests-only', 'include only test files')
  .option('--include-mocks', 'include mock/fixture/fake files')
  .option('--include-config', 'include config files')
  .option('--include-migrations', 'include migration files')
  .action(async (options) => run('context', async (root, format, startedAt) => {
    const mode = ['architecture', 'overview', 'edit_prep', 'composition', 'test_impact'].includes(options.mode) ? options.mode : 'full';
    const data = await buildContext(root, { goal: options.goal, path: options.path, budget: Number(options.budget), includeTests: options.includeTests, changedOnly: options.changedOnly, mode, productionOnly: Boolean(options.productionOnly), testsOnly: Boolean(options.testsOnly), includeMocks: Boolean(options.includeMocks), includeConfig: Boolean(options.includeConfig), includeMigrations: Boolean(options.includeMigrations) });
    printResult(format, renderContext(data), envelope(root, { command: 'context', goal: options.goal }, data, startedAt));
  }));

program.command('index')
  .argument('[directory]', 'directory', '.')
  .option('--clear', 'clear old index')
  .option('--watch', 'watch for changes')
  .option('--jobs <n>', 'worker jobs')
  .action(async (directory, options) => run('index', async (root, format, startedAt) => {
    if (options.watch) throw new Error('--watch is reserved for a future long-running indexer');
    const data = await buildIndex(root, directory, { clear: Boolean(options.clear) });
    printResult(format, renderIndex(data), envelope(root, { command: 'index', path: directory }, data, startedAt));
  }));

program.command('batch')
  .action(async () => run('batch', async (root) => {
    const input = await readStdin();
    const payload = JSON.parse(input) as { operations: Array<Record<string, unknown>> };
    printResult('json', '', await runBatch(root, payload.operations ?? []));
  }));

program.command('doctor')
  .action(async () => run('doctor', async (root, format, startedAt) => {
    const data = await doctor(root);
    printResult(format, renderDoctor(data), envelope(root, { command: 'doctor' }, data, startedAt));
  }));

program.command('mcp')
  .description('start MCP server over stdio')
  .action(async () => {
    await import('./mcp-server.js');
  });

async function run(command: string, handler: (root: string, format: 'text' | 'json', startedAt: number, globals: Record<string, unknown>) => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    const globals = program.opts<Record<string, unknown>>();
    const root = normalizeRoot(String(globals.root ?? '.'));
    setConfigPath(root, globals.config ? String(globals.config) : undefined);
    const format = globals.format === 'json' ? 'json' : 'text';
    await handler(root, format, startedAt, globals);
  } catch (error) {
    process.stderr.write(`${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

await program.parseAsync(process.argv);
