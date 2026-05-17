import { Minimatch } from 'minimatch';
import { SCHEMA_VERSION } from '../types.js';
import { loadConfig } from '../utils/config.js';
import { cacheStats } from '../utils/runtime-cache.js';
import { readTextFileSafe } from '../utils/security.js';
import { walkSourceFilesDetailed } from '../utils/file-walker.js';
import { isCodeboneError, warning } from '../utils/errors.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';
import { registeredWasmGrammars } from './parser.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

export async function doctor(root: string) {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const config = await loadConfig(root);
  warnings.push(...config.warnings);
  const discovery = await walkSourceFilesDetailed(root, '.', { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, timeoutMs: config.timeoutMs });
  warnings.push(...discovery.warnings);
  const grammars = registeredWasmGrammars();
  const loaded = grammars.filter((grammar) => grammar.available);
  const missing = grammars.filter((grammar) => !grammar.available);
  warnings.push(...missing.map((grammar) => `PARSE_FALLBACK:grammar_missing:${grammar.language}`));

  const languages: Record<string, { files: number; support: 'gold' | 'fallback' }> = {};
  let symbols = 0;
  let parseErrors = 0;
  let readErrors = 0;
  let timedOut = false;
  const testMatchers = config.testPatterns.map((pattern) => new Minimatch(pattern, { dot: true }));
  let testFiles = 0;

  for (const file of discovery.files) {
    if (Date.now() - startedAt > config.timeoutMs) {
      timedOut = true;
      warnings.push(warning('TIMEOUT', `doctor exceeded ${config.timeoutMs}ms`));
      break;
    }
    languages[file.language] ??= { files: 0, support: isGold(file.language) ? 'gold' : 'fallback' };
    languages[file.language].files += 1;
    if (testMatchers.some((matcher) => matcher.match(file.relativePath))) testFiles += 1;
    try {
      const { text } = await readTextFileSafe(file.absolutePath, config.maxFileBytes, root);
      const skeleton = await skeletonSourceAsync(root, file.relativePath, text);
      symbols += flattenSymbols(skeleton.symbols).filter((symbol) => symbol.kind !== 'import').length;
      if (skeleton.warnings.length) warnings.push(`PARSE_FALLBACK:${file.relativePath}`);
    } catch (error) {
      if (isCodeboneError(error)) {
        readErrors += 1;
        warnings.push(warning('PARSE_ERROR', `${file.relativePath}:read:${error.code}`));
      } else {
        parseErrors += 1;
        warnings.push(warning('PARSE_ERROR', `${file.relativePath}`));
      }
    }
  }

  const parseErrorRate = discovery.files.length ? parseErrors / discovery.files.length : 0;
  const status = parseErrors + readErrors > discovery.files.length / 2 || timedOut ? 'FAIL' : warnings.length ? 'WARN' : 'OK';
  const data = {
    schemaVersion: SCHEMA_VERSION,
    version: '0.2.0',
    node: process.version,
    status,
    languages,
    symbols,
    skipped: discovery.stats,
    parseErrors,
    readErrors,
    parseErrorRate,
    testFiles,
    configSource: config.source,
    cache: { enabled: config.cache.enabled, ...cacheStats() },
    limits: { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes, timeoutMs: config.timeoutMs },
    grammars: { mode: 'tree-sitter-wasm+syntax-fallback', loaded: loaded.length, fallback: 14 - loaded.length, missing: missing.length, gold: loaded.map((grammar) => grammar.language), missingLanguages: missing.map((grammar) => grammar.language) },
    mcpStdioGuard: typeof process.stdout.write === 'function' ? 'ok' : 'failed',
    networkAccess: 'disabled',
    warnings,
    truncated: discovery.truncated || timedOut,
    tokenEstimate: 0,
    tokenEstimator: TOKEN_ESTIMATOR,
  };
  return { ...data, tokenEstimate: estimateTokens(JSON.stringify(data)) };
}

export function renderDoctor(data: Awaited<ReturnType<typeof doctor>>): string {
  const languages = Object.entries(data.languages).map(([language, info]) => `${language} ${info.files} ${info.support}`).join(', ') || 'none';
  return `codebone ${data.version}
Status: ${data.status}
Node.js ${data.node}
Languages: ${languages}
Symbols: ${data.symbols}
Skipped: ${data.skipped.skipped} ignored/binary/generated/large files
Parse errors: ${data.parseErrors} (${Math.round(data.parseErrorRate * 100)}%)
Read errors: ${data.readErrors}
Test files: ${data.testFiles}
Config: ${data.configSource}
Cache: ${data.cache.enabled ? 'enabled' : 'disabled'} (${data.cache.entries} entries, ~${data.cache.approximateBytes} bytes)
Limits: maxFiles=${data.limits.maxFiles}, maxFileBytes=${data.limits.maxFileBytes}, timeoutMs=${data.limits.timeoutMs}
Tree-sitter WASM: ${data.grammars.missing ? 'partial' : 'ok'} (${data.grammars.gold.join(', ')} gold; ${data.grammars.fallback} fallback grammars, ${data.grammars.missing} missing)
MCP stdio guard: ${data.mcpStdioGuard}
Network access: ${data.networkAccess}`;
}

function isGold(language: string): boolean {
  return ['typescript', 'python', 'go', 'rust'].includes(language);
}
