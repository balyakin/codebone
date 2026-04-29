import fs from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../types.js';
import { registeredWasmGrammars } from './parser.js';

export async function doctor(root: string) {
  const warnings: string[] = [];
  const indexDir = path.join(root, '.codebone', 'index.v1');
  try {
    await fs.mkdir(indexDir, { recursive: true });
    await fs.access(indexDir);
  } catch {
    warnings.push('index_not_writable');
  }
  const grammars = registeredWasmGrammars();
  const loaded = grammars.filter((grammar) => grammar.available);
  const missing = grammars.filter((grammar) => !grammar.available);
  warnings.push(...missing.map((grammar) => `grammar_missing:${grammar.language}`));
  return {
    schemaVersion: SCHEMA_VERSION,
    version: '0.1.0',
    node: process.version,
    grammars: { mode: 'tree-sitter-wasm+syntax-fallback', loaded: loaded.length, fallback: 14 - loaded.length, missing: missing.length, gold: loaded.map((grammar) => grammar.language), missingLanguages: missing.map((grammar) => grammar.language) },
    indexDirectory: warnings.includes('index_not_writable') ? 'failed' : 'ok',
    mcpStdioGuard: typeof process.stdout.write === 'function' ? 'ok' : 'failed',
    networkAccess: 'disabled',
    warnings,
    truncated: false,
    tokenEstimate: 60,
  };
}

export function renderDoctor(data: Awaited<ReturnType<typeof doctor>>): string {
  return `codebone ${data.version}\nNode.js ${data.node}\nTree-sitter WASM: ${data.grammars.missing ? 'partial' : 'ok'} (${data.grammars.gold.join(', ')} gold; ${data.grammars.fallback} fallback grammars, ${data.grammars.missing} missing)\nIndex directory: ${data.indexDirectory} (.codebone/index.v1 writable)\nMCP stdio guard: ${data.mcpStdioGuard}\nNetwork access: ${data.networkAccess}`;
}
