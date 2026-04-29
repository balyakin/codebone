import fs from 'node:fs/promises';
import path from 'node:path';
import { walkSourceFiles } from '../utils/file-walker.js';
import { readTextFileSafe } from '../utils/security.js';
import { skeletonSourceAsync } from './skeleton.js';

export interface ImportEdge {
  from: string;
  source: string;
  resolved?: string;
}

export interface ExportEntry {
  file: string;
  name: string;
  kind: string;
}

export interface ImportGraph {
  edges: ImportEdge[];
  exports: ExportEntry[];
  summary: {
    imports: number;
    resolvedImports: number;
    exports: number;
    hotFiles: Array<{ path: string; imports: number; importedBy: number }>;
  };
}

export async function buildImportGraph(root: string, inputPath = '.'): Promise<ImportGraph> {
  const files = await walkSourceFiles(root, inputPath, { maxFiles: 10000 });
  const fileSet = new Set(files.map((file) => file.relativePath));
  const edges: ImportEdge[] = [];
  const exports: ExportEntry[] = [];

  for (const file of files) {
    const { text } = await readTextFileSafe(file.absolutePath, undefined, root);
    const skeleton = await skeletonSourceAsync(root, file.relativePath, text);
    for (const symbol of skeleton.symbols) {
      if (symbol.kind === 'import' && symbol.source) edges.push({ from: file.relativePath, source: symbol.source, resolved: resolveImport(file.relativePath, symbol.source, fileSet) });
      if (symbol.exported) exports.push({ file: file.relativePath, name: symbol.qualifiedName, kind: symbol.kind });
    }
  }

  return summarizeGraph(edges, exports, fileSet);
}

export function summarizeGraph(edges: ImportEdge[], exports: ExportEntry[], fileSet: Set<string>): ImportGraph {
  const importsByFile = new Map<string, number>();
  const importedByFile = new Map<string, number>();
  for (const edge of edges) {
    importsByFile.set(edge.from, (importsByFile.get(edge.from) ?? 0) + 1);
    if (edge.resolved) importedByFile.set(edge.resolved, (importedByFile.get(edge.resolved) ?? 0) + 1);
  }
  const hotFiles = [...fileSet].map((filePath) => ({ path: filePath, imports: importsByFile.get(filePath) ?? 0, importedBy: importedByFile.get(filePath) ?? 0 }))
    .sort((a, b) => (b.imports + b.importedBy) - (a.imports + a.importedBy) || a.path.localeCompare(b.path))
    .slice(0, 10);
  return { edges, exports, summary: { imports: edges.length, resolvedImports: edges.filter((edge) => edge.resolved).length, exports: exports.length, hotFiles } };
}

export function resolveImport(from: string, source: string, fileSet: Set<string>): string | undefined {
  if (!source.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), source));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`, `${base}.go`, `${base}.rs`, path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.js')];
  return candidates.find((candidate) => fileSet.has(candidate));
}
