import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let initialized: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();

export const languageWasm: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
};

export interface AstCapture {
  name: string;
  text: string;
  type: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}

export async function parseWithTreeSitter(languageId: string, source: string) {
  const language = await loadLanguage(languageId);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Failed to parse ${languageId}`);
  return { language, parser, tree };
}

export async function queryCaptures(languageId: string, source: string, querySource: string): Promise<AstCapture[]> {
  const parsed = await parseWithTreeSitter(languageId, source);
  try {
    const query = new Query(parsed.language, querySource);
    try {
      return query.captures(parsed.tree.rootNode).map((capture) => ({
        name: capture.name,
        text: capture.node.text,
        type: capture.node.type,
        startLine: capture.node.startPosition.row + 1,
        startColumn: capture.node.startPosition.column,
        endLine: capture.node.endPosition.row + 1,
        endColumn: capture.node.endPosition.column,
        startByte: capture.node.startIndex,
        endByte: capture.node.endIndex,
      }));
    } finally {
      query.delete();
    }
  } finally {
    parsed.tree.delete();
    parsed.parser.delete();
  }
}

async function loadLanguage(languageId: string): Promise<Language> {
  const wasm = languageWasm[languageId];
  if (!wasm) throw new Error(`No tree-sitter WASM registered for language: ${languageId}`);
  await initParser();
  if (!languages.has(languageId)) {
    const wasmPath = resolveGrammarWasm(wasm);
    languages.set(languageId, Language.load(wasmPath));
  }
  return languages.get(languageId)!;
}

function resolveGrammarWasm(fileName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vendored = [
    path.resolve(here, '../languages/wasm', fileName),
    path.resolve(here, '../src/languages/wasm', fileName),
  ];
  const found = vendored.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  const packageMap: Record<string, string> = {
    'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
    'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
    'tree-sitter-go.wasm': 'tree-sitter-go/tree-sitter-go.wasm',
    'tree-sitter-rust.wasm': 'tree-sitter-rust/tree-sitter-rust.wasm',
  };
  if (packageMap[fileName]) return require.resolve(packageMap[fileName]);
  throw new Error(`Vendored WASM grammar not found: ${fileName}`);
}

export function registeredWasmGrammars(): Array<{ language: string; wasm: string; available: boolean }> {
  return Object.entries(languageWasm).map(([language, wasm]) => ({ language, wasm, available: hasWasmGrammar(wasm) }));
}

export function hasWasmGrammar(fileName: string): boolean {
  try {
    resolveGrammarWasm(fileName);
    return true;
  } catch {
    return false;
  }
}

function initParser(): Promise<void> {
  if (!initialized) {
    initialized = Parser.init({
      locateFile(fileName: string) {
        if (fileName === 'web-tree-sitter.wasm') return require.resolve('web-tree-sitter/web-tree-sitter.wasm');
        return path.basename(fileName);
      },
    });
  }
  return initialized;
}
