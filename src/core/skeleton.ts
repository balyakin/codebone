import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageForPath } from '../languages/registry.js';
import { CodeSymbol, SCHEMA_VERSION, SkeletonData, SymbolKind } from '../types.js';
import { estimateTokens } from './budget.js';
import { resolveInsideRoot, toRelative } from '../utils/paths.js';
import { readTextFileSafe } from '../utils/security.js';
import { AstCapture, hasWasmGrammar, languageWasm, queryCaptures } from './parser.js';

interface Candidate {
  kind: SymbolKind;
  name: string;
  qualifiedName?: string;
  signature: string;
  startLine: number;
  endLine?: number;
  exported?: boolean;
  visibility?: 'public' | 'private' | 'protected';
  source?: string;
  parent?: string;
  startColumn?: number;
  endColumn?: number;
  startByte?: number;
  endByte?: number;
}

interface ExtractOptions {
  publicOnly?: boolean;
  noImports?: boolean;
  publicApiOnly?: boolean;
  symbolsOnly?: boolean;
  includePrivate?: boolean;
  includeRoutes?: boolean;
  detail?: 'rpc_api' | 'lifecycle' | 'app_dependencies' | 'public_methods';
  budget?: number;
}

export async function skeletonPath(root: string, inputPath: string, options: ExtractOptions = {}): Promise<SkeletonData> {
  const absolutePath = resolveInsideRoot(root, inputPath);
  const { text: source } = await readTextFileSafe(absolutePath, undefined, root);
  const relativePath = toRelative(root, absolutePath);
  return skeletonSourceAsync(root, relativePath, source, options);
}

export async function skeletonSourceAsync(root: string, relativePath: string, source: string, options: ExtractOptions = {}): Promise<SkeletonData> {
  const language = languageForPath(relativePath)?.id ?? 'unknown';
  if (languageWasm[parserLanguageForPath(relativePath, language)] && hasWasmGrammar(languageWasm[parserLanguageForPath(relativePath, language)])) {
    try {
      return skeletonFromCandidates(root, relativePath, source, await extractTreeSitterCandidates(parserLanguageForPath(relativePath, language), source), options, []);
    } catch (error) {
      const data = skeletonSource(root, relativePath, source, options);
      data.warnings.push(`tree_sitter_fallback:${error instanceof Error ? error.message : String(error)}`);
      return data;
    }
  }
  return skeletonSource(root, relativePath, source, options);
}

export function skeletonSource(root: string, relativePath: string, source: string, options: ExtractOptions = {}): SkeletonData {
  const language = languageForPath(relativePath)?.id ?? 'unknown';
  return skeletonFromCandidates(root, relativePath, source, extractCandidates(language, source.split(/\r?\n/)), options, language === 'unknown' ? ['unsupported_language'] : []);
}

function skeletonFromCandidates(root: string, relativePath: string, source: string, candidates: Candidate[], options: ExtractOptions, warnings: string[]): SkeletonData {
  const language = languageForPath(relativePath)?.id ?? 'unknown';
  const lines = source.split(/\r?\n/);
  const lineStarts = computeLineStarts(source, lines);
  const allCandidates = language === 'python' ? uniqueCandidates([...candidates, ...extractPythonLandmarks(lines)]) : candidates;
  const symbols = filterDetailLevel(filterPublicApi(filterSymbols(attachChildren(allCandidates.filter((symbol) => !options.noImports || symbol.kind !== 'import')
    .map((candidate) => toSymbol(root, relativePath, language, source, lines, lineStarts, candidate))), Boolean(options.publicOnly)), Boolean(options.publicApiOnly)), options);
  const rendered = symbols.map(renderSymbolText).join('\n');
  const tokenEstimate = estimateTokens(rendered);
  let outputSymbols = symbols;
  let omitted: Array<{ path: string; reason: string }> | undefined;
  let truncated = false;
  if (options.budget && tokenEstimate > options.budget) {
    outputSymbols = [];
    let tokens = 0;
    let omittedCount = 0;
    for (const symbol of symbols) {
      const cost = estimateTokens(renderSymbolText(symbol));
      if (tokens + cost > options.budget) {
        truncated = true;
        omittedCount += 1;
        continue;
      }
      outputSymbols.push(symbol);
      tokens += cost;
    }
    if (omittedCount > 0) omitted = [{ path: relativePath, reason: `budget_exceeded:${omittedCount}_symbols` }];
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    file: relativePath,
    language,
    totalLines: lines.length,
    symbols: outputSymbols,
    omitted,
    warnings,
    truncated,
    tokenEstimate: estimateTokens(outputSymbols.map(renderSymbolText).join('\n')),
  };
}

function uniqueCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.name}:${candidate.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractTreeSitterCandidates(language: string, source: string): Promise<Candidate[]> {
  const query = await readQuery(language);
  const captures = await queryCaptures(language, source, query);
  const sourceLines = source.split(/\r?\n/);
  const exportCaptures = captures.filter((item) => item.name === 'export');
  const candidates: Candidate[] = [];

  for (const capture of captures.filter((item) => item.name.endsWith('.def') || item.name === 'import')) {
    if (capture.name === 'import') {
      candidates.push({ kind: 'import', name: importName(capture.text), source: importSource(capture.text), signature: firstLine(capture.text), ...rangeCandidate(capture), exported: false });
      continue;
    }
    let kind = capture.name.replace('.def', '') as SymbolKind;
    if (!['function', 'class', 'interface', 'type', 'enum', 'method', 'property', 'struct', 'trait', 'impl', 'constant', 'variable'].includes(kind)) continue;
    const name = findNameCapture(captures, capture, kind)?.text ?? inferName(language, kind, capture.text);
    if (!name) continue;
    let parent = kind === 'method' || kind === 'property' ? findContainingParent(language, candidates, capture) : undefined;
    if (language === 'python' && kind === 'function') {
      parent = findContainingParent(language, candidates, capture);
      if (parent) kind = 'method';
    }
    candidates.push({
      kind,
      name,
      qualifiedName: parent ? `${parent}.${name}` : name,
      parent,
      signature: signatureBeforeBody(firstLine(capture.text)),
      exported: kind === 'method' || kind === 'property' ? false : exportedFromCapture(language, name, capture, sourceLines, exportCaptures),
      visibility: visibilityFromText(capture.text),
      ...rangeCandidate(capture),
    });
  }

  return candidates.sort((a, b) => a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0));
}

export function renderSkeleton(data: SkeletonData): string {
  const hidden = Math.max(0, estimateTokens('x'.repeat(data.totalLines * 80)) - data.tokenEstimate);
  const body = data.symbols.map(renderSymbolText).join('\n');
  return `${data.file} (${data.totalLines} lines, ~${hidden} tokens hidden)${body ? `\n\n${body}` : ''}`;
}

export function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return symbols.flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children ?? [])]);
}

function extractCandidates(language: string, lines: string[]): Candidate[] {
  if (language === 'python') return extractPython(lines);
  if (language === 'go') return extractGo(lines);
  if (language === 'rust') return extractRust(lines);
  if (['typescript', 'javascript'].includes(language)) return extractTsJs(lines);
  return extractCStyle(lines);
}

function extractTsJs(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  const classStack: { name: string; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNo = index + 1;
    while (classStack.length && lineNo > classStack[classStack.length - 1].end) classStack.pop();
    const exported = /\bexport\b/.test(trimmed);
    const importMatch = trimmed.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|^(?:const|let|var)\s+(.+?)\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (importMatch) out.push({ kind: 'import', name: cleanupName(importMatch[1] ?? importMatch[3] ?? importMatch[4] ?? 'import'), source: importMatch[2] ?? importMatch[3] ?? importMatch[5], signature: trimmed, startLine: lineNo, endLine: lineNo, exported: false });
    const typeMatch = trimmed.match(/^(?:export\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (typeMatch) out.push({ kind: typeMatch[1] as SymbolKind, name: typeMatch[2], signature: trimSignature(lines, index), startLine: lineNo, endLine: findBlockEnd(lines, index), exported });
    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const endLine = findBlockEnd(lines, index);
      out.push({ kind: 'class', name: classMatch[1], signature: trimSignature(lines, index), startLine: lineNo, endLine, exported });
      classStack.push({ name: classMatch[1], end: endLine });
    }
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/) ?? trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (fnMatch) out.push({ kind: 'function', name: fnMatch[1], signature: signatureBeforeBody(trimSignature(lines, index)), startLine: lineNo, endLine: findBlockEnd(lines, index), exported });
    const parent = classStack[classStack.length - 1]?.name;
    if (parent && !/^(if|for|while|switch|catch)\b/.test(trimmed)) {
      const methodMatch = trimmed.match(/^(?:(public|private|protected)\s+)?(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[^=;{]*\{/);
      if (methodMatch && methodMatch[2] !== 'constructor') out.push({ kind: 'method', name: methodMatch[2], qualifiedName: `${parent}.${methodMatch[2]}`, parent, visibility: (methodMatch[1] as Candidate['visibility']) ?? 'public', signature: signatureBeforeBody(trimSignature(lines, index)), startLine: lineNo, endLine: findBlockEnd(lines, index), exported: false });
      const propMatch = trimmed.match(/^(?:(public|private|protected)\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:=;]/);
      if (propMatch) out.push({ kind: 'property', name: propMatch[2], qualifiedName: `${parent}.${propMatch[2]}`, parent, visibility: (propMatch[1] as Candidate['visibility']) ?? 'public', signature: trimmed.replace(/;$/, ''), startLine: lineNo, endLine: lineNo, exported: false });
    }
  }
  return out;
}

function extractPython(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  const classStack: { name: string; indent: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNo = index + 1;
    const indent = line.search(/\S|$/);
    while (classStack.length && indent <= classStack[classStack.length - 1].indent && trimmed) classStack.pop();
    const importMatch = trimmed.match(/^(?:from\s+([.\w]+)\s+import\s+(.+)|import\s+([\w.]+))/);
    if (importMatch) out.push({ kind: 'import', name: cleanupName(importMatch[2] ?? importMatch[3]), source: importMatch[1] ?? importMatch[3], signature: trimmed, startLine: lineNo, endLine: lineNo });
    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      out.push({ kind: 'class', name: classMatch[1], signature: trimmed, startLine: lineNo, endLine: findPythonBlockEnd(lines, index, indent), exported: !classMatch[1].startsWith('_') });
      classStack.push({ name: classMatch[1], indent });
    }
    const fnMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (fnMatch) {
      const parent = classStack[classStack.length - 1]?.name;
      out.push({ kind: parent ? 'method' : 'function', name: fnMatch[1], qualifiedName: parent ? `${parent}.${fnMatch[1]}` : fnMatch[1], parent, visibility: fnMatch[1].startsWith('_') ? 'private' : 'public', signature: trimmed, startLine: lineNo, endLine: findPythonBlockEnd(lines, index, indent), exported: !fnMatch[1].startsWith('_') });
    }
    if (indent === 0) {
      const variableMatch = trimmed.match(/^([A-Za-z_]\w*)\s*(?::\s*[^=]+)?\s*=\s*.+/);
      if (variableMatch) {
        const name = variableMatch[1];
        out.push({ kind: /^[A-Z_][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable', name, signature: trimmed, startLine: lineNo, endLine: lineNo, exported: !name.startsWith('_'), visibility: name.startsWith('_') ? 'private' : 'public' });
      }
    }
  }
  return out;
}

function extractPythonLandmarks(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineNo = index + 1;
    const route = pythonRoute(lines, index);
    if (route) out.push({ kind: 'route', name: `${route.method} ${route.path}`, source: route.handler, signature: route.signature, startLine: lineNo, endLine: route.endLine, exported: true });
    const dependencyMatch = trimmed.match(/\bapp\[['"]([^'"]+)['"]\]|\brequest\.app\[['"]([^'"]+)['"]\]/);
    if (dependencyMatch) out.push({ kind: 'dependency', name: dependencyMatch[1] ?? dependencyMatch[2], signature: trimmed, startLine: lineNo, endLine: lineNo, exported: true });
    const tableName = pythonTableName(lines, index);
    if (tableName) out.push({ kind: 'table', name: tableName, signature: trimSignature(lines, index), startLine: lineNo, endLine: findParenEnd(lines, index), exported: true });
  }
  return out;
}

function pythonRoute(lines: string[], index: number): { method: string; path: string; handler?: string; signature: string; endLine: number } | undefined {
  const trimmed = lines[index].trim();
  const decorator = trimmed.match(/^@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]/);
  if (decorator) return { method: decorator[1].toUpperCase(), path: decorator[2], signature: trimmed, endLine: index + 1 };

  const addRoute = trimmed.match(/(?:\w+\.)?router\.add_(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]\s*(?:,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))?/);
  if (addRoute) return { method: addRoute[1].toUpperCase(), path: addRoute[2], handler: addRoute[3], signature: trimmed, endLine: index + 1 };

  const webRoute = trimmed.match(/\bweb\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]\s*(?:,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))?/);
  if (webRoute) return { method: webRoute[1].toUpperCase(), path: webRoute[2], handler: webRoute[3], signature: trimmed, endLine: index + 1 };

  const windowText = lines.slice(index, Math.min(lines.length, index + 8)).map((line) => line.trim()).join(' ');
  const multilineWeb = windowText.match(/\bweb\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
  if (multilineWeb) return { method: multilineWeb[1].toUpperCase(), path: multilineWeb[2], handler: multilineWeb[3], signature: windowText, endLine: Math.min(lines.length, index + 8) };

  return undefined;
}

function pythonTableName(lines: string[], index: number): string | undefined {
  if (!/^\s*[A-Za-z_]\w*\s*=\s*(?:\w+\.)?Table\(/.test(lines[index])) return undefined;
  const text = lines.slice(index, Math.min(lines.length, index + 5)).map((line) => line.trim()).join(' ');
  return text.match(/(?:^|=\s*)(?:\w+\.)?Table\([^'"]*['"]([^'"]+)['"]/)?.[1]
    ?? text.match(/(?:^|=\s*)sa\.Table\([^'"]*['"]([^'"]+)['"]/)?.[1]
    ?? text.match(/(?:^|=\s*)sqlalchemy\.Table\([^'"]*['"]([^'"]+)['"]/)?.[1];
}

function extractGo(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineNo = index + 1;
    if (/^import\b/.test(trimmed)) out.push({ kind: 'import', name: 'import', signature: trimmed, startLine: lineNo, endLine: trimmed.endsWith('(') ? findParenEnd(lines, index) : lineNo });
    const typeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
    if (typeMatch) out.push({ kind: typeMatch[2] as SymbolKind, name: typeMatch[1], signature: trimmed, startLine: lineNo, endLine: findBlockEnd(lines, index), exported: isExported(typeMatch[1]) });
    const fnMatch = trimmed.match(/^func\s+(?:\(([^)]+)\)\s*)?([A-Za-z_]\w*)\s*\(/);
    if (fnMatch) {
      const receiver = fnMatch[1]?.trim().split(/\s+/).pop()?.replace(/^\*/, '');
      const name = fnMatch[2];
      out.push({ kind: receiver ? 'method' : 'function', name, qualifiedName: receiver ? `${receiver}.${name}` : name, parent: receiver, signature: signatureBeforeBody(trimmed), startLine: lineNo, endLine: findBlockEnd(lines, index), exported: isExported(name), visibility: isExported(name) ? 'public' : 'private' });
    }
  }
  return out;
}

function extractRust(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineNo = index + 1;
    if (/^use\s+/.test(trimmed)) out.push({ kind: 'import', name: cleanupName(trimmed.replace(/^use\s+/, '')), signature: trimmed, startLine: lineNo, endLine: lineNo });
    const typeMatch = trimmed.match(/^(?:pub\s+)?(struct|enum|trait|impl)\s+([A-Za-z_]\w*)?/);
    if (typeMatch) out.push({ kind: typeMatch[1] as SymbolKind, name: typeMatch[2] ?? 'impl', signature: trimmed, startLine: lineNo, endLine: findBlockEnd(lines, index), exported: trimmed.startsWith('pub ') });
    const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/);
    if (fnMatch) out.push({ kind: 'function', name: fnMatch[1], signature: signatureBeforeBody(trimmed), startLine: lineNo, endLine: findBlockEnd(lines, index), exported: trimmed.startsWith('pub '), visibility: trimmed.startsWith('pub ') ? 'public' : 'private' });
  }
  return out;
}

function extractCStyle(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineNo = index + 1;
    const importMatch = trimmed.match(/^(?:#include\s+[<"].+[>"]|import\s+.+;|using\s+.+;|require\s+.+|include\s+.+)/);
    if (importMatch) out.push({ kind: 'import', name: cleanupName(trimmed), signature: trimmed, startLine: lineNo, endLine: lineNo });
    const classMatch = trimmed.match(/^(?:public\s+)?(?:final\s+)?(class|interface|enum|struct)\s+([A-Za-z_]\w*)/);
    if (classMatch) out.push({ kind: classMatch[1] as SymbolKind, name: classMatch[2], signature: trimmed, startLine: lineNo, endLine: findBlockEnd(lines, index), exported: /^(public|export)/.test(trimmed), visibility: /^public/.test(trimmed) ? 'public' : undefined });
    const fnMatch = trimmed.match(/^(?:public|private|protected|static|final|async|override|export|suspend|func|fun|def|function|void|int|string|bool|double|float|[A-Z_a-z][\w<>:[\],?*&\s]+)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:[:\w\s]*)?\{/);
    if (fnMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(fnMatch[1])) out.push({ kind: 'function', name: fnMatch[1], signature: signatureBeforeBody(trimmed), startLine: lineNo, endLine: findBlockEnd(lines, index), exported: /^(public|export)/.test(trimmed), visibility: trimmed.startsWith('private') ? 'private' : trimmed.startsWith('protected') ? 'protected' : 'public' });
  }
  return out;
}

function toSymbol(root: string, file: string, language: string, source: string, lines: string[], lineStarts: number[], candidate: Candidate): CodeSymbol {
  const endLine = Math.max(candidate.endLine ?? candidate.startLine, candidate.startLine);
  const startColumn = candidate.startColumn ?? firstNonWhitespaceColumn(lines[candidate.startLine - 1] ?? '');
  const endColumn = candidate.endColumn ?? lines[endLine - 1]?.length ?? 0;
  const startByte = candidate.startByte ?? lineStarts[candidate.startLine - 1] + startColumn;
  const endByte = candidate.endByte ?? lineStarts[endLine - 1] + endColumn;
  const qualifiedName = candidate.qualifiedName ?? candidate.name;
  const hash = crypto.createHash('sha1').update(source.slice(startByte, endByte)).digest('hex').slice(0, 8);
  return {
    symbolId: `${file}#${candidate.kind}:${qualifiedName}@${candidate.startLine}:${startColumn}-${endLine}:${endColumn}:${hash}`,
    contentHash: hash,
    kind: candidate.kind,
    name: candidate.name,
    qualifiedName,
    signature: candidate.signature,
    exported: Boolean(candidate.exported),
    confidence: ['typescript', 'python', 'go', 'rust'].includes(language) ? 'high' : 'medium',
    parameters: parseParameters(candidate.signature),
    returnType: parseReturnType(candidate.signature),
    visibility: candidate.visibility,
    source: candidate.source,
    language,
    file,
    startLine: candidate.startLine,
    startColumn,
    endLine,
    endColumn,
    startByte,
    endByte,
  };
}

function renderSymbolText(symbol: CodeSymbol): string {
  const range = `${symbol.startLine}..${symbol.endLine}`.padStart(9);
  const prefix = symbol.kind.toUpperCase().padEnd(9);
  return `${range}  ${prefix} ${symbol.signature}`;
}

function computeLineStarts(source: string, lines: string[]): number[] {
  const starts = [0];
  let byteOffset = 0;
  for (const char of source) {
    byteOffset += Buffer.byteLength(char);
    if (char === '\n') starts.push(byteOffset);
  }
  return starts.slice(0, lines.length);
}

function trimSignature(lines: string[], index: number): string {
  const parts: string[] = [];
  for (let i = index; i < Math.min(lines.length, index + 5); i += 1) {
    parts.push(lines[i].trim());
    const text = parts.join(' ');
    if (/[{;:]\s*$/.test(text) || text.includes('=>')) return text;
  }
  return parts.join(' ');
}

function signatureBeforeBody(value: string): string {
  return value.replace(/\s*\{.*$/, '').replace(/\s*=>.*$/, ' =>');
}

function findBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let seen = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '{') { depth += 1; seen = true; }
      if (char === '}') depth -= 1;
    }
    if (seen && depth <= 0) return i + 1;
  }
  return startIndex + 1;
}

function findParenEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const char of lines[i]) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
    }
    if (depth <= 0) return i + 1;
  }
  return startIndex + 1;
}

function findPythonBlockEnd(lines: string[], startIndex: number, indent: number): number {
  let end = startIndex + 1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const currentIndent = line.search(/\S|$/);
    if (currentIndent <= indent) break;
    end = i + 1;
  }
  return end;
}

function cleanupName(value: string): string {
  return value.replace(/[{};'"]/g, '').trim().slice(0, 80);
}

function firstNonWhitespaceColumn(value: string): number {
  const match = value.match(/\S/);
  return match?.index ?? 0;
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

async function readQuery(language: string): Promise<string> {
  const queryLanguage = language === 'tsx' ? 'typescript' : language;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../languages/queries', `${queryLanguage}.scm`),
    path.resolve(here, '../src/languages/queries', `${queryLanguage}.scm`),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Try next package layout.
    }
  }
  throw new Error(`Query not found for ${queryLanguage}`);
}

function parserLanguageForPath(relativePath: string, language: string): string {
  return /\.tsx$/i.test(relativePath) ? 'tsx' : language;
}

function rangeCandidate(capture: AstCapture): Pick<Candidate, 'startLine' | 'startColumn' | 'endLine' | 'endColumn' | 'startByte' | 'endByte'> {
  return {
    startLine: capture.startLine,
    startColumn: capture.startColumn,
    endLine: capture.endLine,
    endColumn: capture.endColumn,
    startByte: capture.startByte,
    endByte: capture.endByte,
  };
}

function findNameCapture(captures: AstCapture[], def: AstCapture, kind: SymbolKind): AstCapture | undefined {
  return captures.find((capture) => capture.name === `${kind}.name` && capture.startByte >= def.startByte && capture.endByte <= def.endByte);
}

function findContainingParent(language: string, candidates: Candidate[], capture: AstCapture): string | undefined {
  if (language === 'go') return inferGoReceiver(capture.text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (['class', 'struct', 'impl'].includes(candidate.kind) && candidate.startByte !== undefined && candidate.endByte !== undefined && candidate.startByte <= capture.startByte && candidate.endByte >= capture.endByte) return candidate.name;
  }
  return undefined;
}

function inferName(language: string, kind: SymbolKind, text: string): string | undefined {
  const trimmed = text.trim();
  if (kind === 'impl' && language === 'rust') return trimmed.match(/^impl(?:\s+\w+\s+for)?\s+([A-Za-z_]\w*)/)?.[1] ?? 'impl';
  if (kind === 'constant' || kind === 'variable') return trimmed.match(/(?:const|var|let)\s+([A-Za-z_]\w*)/)?.[1];
  return undefined;
}

function inferGoReceiver(text: string): string | undefined {
  return text.trim().match(/^func\s+\(([^)]+)\)/)?.[1]?.trim().split(/\s+/).pop()?.replace(/^\*/, '');
}

function exportedFromCapture(language: string, name: string, capture: AstCapture, sourceLines: string[], exportCaptures: AstCapture[]): boolean {
  if (language === 'python') return !name.startsWith('_');
  if (language === 'go') return isExported(name);
  if (language === 'rust') return /^pub\b/.test(capture.text.trim()) || /^\s*pub\b/.test(sourceLines[capture.startLine - 1] ?? '');
  return /^export\b/.test(capture.text.trim()) || /^\s*export\b/.test(sourceLines[capture.startLine - 1] ?? '') || exportCaptures.some((item) => item.startByte <= capture.startByte && item.endByte >= capture.endByte);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0].trim();
}

function visibilityFromText(text: string): Candidate['visibility'] {
  const trimmed = text.trim();
  if (/^private\b/.test(trimmed)) return 'private';
  if (/^protected\b/.test(trimmed)) return 'protected';
  return 'public';
}

function importName(text: string): string {
  const trimmed = text.trim();
  const pythonFrom = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
  if (pythonFrom) return cleanupName(pythonFrom[2]);
  const pythonImport = trimmed.match(/^import\s+([\w.]+)/);
  if (pythonImport) return cleanupName(pythonImport[1]);
  const match = trimmed.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+['"]|^import\s+['"]([^'"]+)['"]|^import\s+([\w.]+)|^use\s+([^;]+);?|^import\s+\(?\s*"([^"]+)"/);
  return cleanupName(match?.slice(1).find(Boolean) ?? 'import');
}

function importSource(text: string): string | undefined {
  const trimmed = text.trim();
  const pythonFrom = trimmed.match(/^from\s+([.\w]+)\s+import\s+/);
  if (pythonFrom) return pythonFrom[1];
  const pythonImport = trimmed.match(/^import\s+([\w.]+)/);
  if (pythonImport) return pythonImport[1];
  return trimmed.match(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s+([\w.]+)|use\s+([^;]+);?|import\s+\(?\s*"([^"]+)"/)?.slice(1).find(Boolean);
}

function attachChildren(symbols: CodeSymbol[]): CodeSymbol[] {
  const childIds = new Set<string>();
  for (const parent of symbols.filter((symbol) => ['class', 'struct', 'impl'].includes(symbol.kind))) {
    parent.children = symbols.filter((symbol) => symbol !== parent && symbol.startByte >= parent.startByte && symbol.endByte <= parent.endByte && ['method', 'property'].includes(symbol.kind));
    for (const child of parent.children) childIds.add(child.symbolId);
  }
  return symbols.filter((symbol) => !childIds.has(symbol.symbolId));
}

function filterSymbols(symbols: CodeSymbol[], publicOnly: boolean): CodeSymbol[] {
  if (!publicOnly) return symbols;
  return symbols.filter((symbol) => symbol.exported).map((symbol) => ({
    ...symbol,
    children: symbol.children?.filter((child) => child.visibility === 'public'),
  }));
}

function filterPublicApi(symbols: CodeSymbol[], publicApiOnly: boolean): CodeSymbol[] {
  if (!publicApiOnly) return symbols;
  const publicKinds = new Set(['class', 'function', 'method', 'route', 'table', 'dependency']);
  return symbols.filter((symbol) => publicKinds.has(symbol.kind) && !symbol.name.startsWith('_')).map((symbol) => ({
    ...symbol,
    children: symbol.children?.filter((child) => publicKinds.has(child.kind) && (!child.name.startsWith('_') || child.name.startsWith('rpc_'))),
  }));
}

function filterDetailLevel(symbols: CodeSymbol[], options: ExtractOptions): CodeSymbol[] {
  return symbols.filter((symbol) => {
    if (options.detail === 'rpc_api') return symbol.kind === 'route' || (['function', 'method'].includes(symbol.kind) && symbol.name.startsWith('rpc_'));
    if (options.detail === 'lifecycle') return ['function', 'method'].includes(symbol.kind) && /startup|shutdown|cleanup|setup|init|destroy|create_app|make_app|start|stop/i.test(symbol.name);
    if (options.detail === 'app_dependencies') return symbol.kind === 'dependency';
    if (options.detail === 'public_methods') return ['class', 'function', 'method'].includes(symbol.kind) && !symbol.name.startsWith('_');
    if (options.symbolsOnly && ['import', 'variable', 'constant', 'property'].includes(symbol.kind)) return false;
    if (options.includeRoutes === false && symbol.kind === 'route') return false;
    if (options.includePrivate === false && symbol.name.startsWith('_') && !symbol.name.startsWith('rpc_')) return false;
    return true;
  }).map((symbol) => ({
    ...symbol,
    children: symbol.children?.filter((child) => options.includePrivate !== false || !child.name.startsWith('_') || child.name.startsWith('rpc_')),
  }));
}

function parseParameters(signature: string): Array<{ name: string; type?: string }> | undefined {
  const body = signature.match(/\(([^)]*)\)/)?.[1].trim();
  if (!body) return undefined;
  return body.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, type] = part.replace(/^(private|public|protected)\s+/, '').split(':').map((value) => value.trim());
    return type ? { name, type } : { name: name.split(/\s+/).pop() ?? name };
  });
}

function parseReturnType(signature: string): string | undefined {
  return signature.match(/\)\s*:\s*([^{}=]+?)(?:\s*(?:=>|\{|$))/)?.[1]?.trim() ?? signature.match(/\)\s+([A-Za-z_][\w<>.[\]*&\s]*)$/)?.[1]?.trim();
}
