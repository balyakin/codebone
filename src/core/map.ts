import path from 'node:path';
import fs from 'node:fs/promises';
import { SCHEMA_VERSION } from '../types.js';
import { walkSourceFiles } from '../utils/file-walker.js';
import { estimateTokens } from './budget.js';
import { buildImportGraph } from './graph.js';
import { languageForPath } from '../languages/registry.js';
import { resolveInsideRoot } from '../utils/paths.js';
import { readTextFileSafe } from '../utils/security.js';
import { flattenSymbols, skeletonSourceAsync } from './skeleton.js';

export async function projectMap(root: string, inputPath = '.', budget = 1200) {
  const files = await walkSourceFiles(root, inputPath, { maxFiles: 10000 });
  const scanned = await countFiles(root, inputPath);
  const graph = await buildImportGraph(root, inputPath);
  const languages: Record<string, number> = {};
  const directories = new Map<string, { files: number; symbols: number }>();
  for (const file of files) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
    const dir = path.posix.dirname(file.relativePath).split('/').slice(0, 2).join('/');
    const dirPath = dir === '.' ? '/' : dir;
    const current = directories.get(dirPath) ?? { files: 0, symbols: 0 };
    let symbolCount = 0;
    try {
      const { text: source } = await readTextFileSafe(file.absolutePath, undefined, root);
      symbolCount = flattenSymbols((await skeletonSourceAsync(root, file.relativePath, source)).symbols).filter((symbol) => symbol.kind !== 'import').length;
    } catch {
      symbolCount = 0;
    }
    directories.set(dirPath, { files: current.files + 1, symbols: current.symbols + symbolCount });
  }
  const entrypoints = files
    .map((file) => file.relativePath)
    .filter((file) => /(^|\/)(index|main|server|cli|app|mcp-server)\.[^.]+$/.test(file))
    .slice(0, 20);
  const topDirectories = [...directories.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 10).map(([dirPath, counts]) => ({ path: dirPath, files: counts.files, symbols: counts.symbols }));
  const suggestedReads = [
    ...(entrypoints[0] ? [{ command: 'skeleton', path: entrypoints[0] }] : []),
    { command: 'skeleton', path: inputPath },
    { command: 'context', goal: 'understand project structure', budget: Math.max(4000, budget * 4) },
  ];
  const data = { schemaVersion: SCHEMA_VERSION, languages, files: { indexed: files.length, ignored: scanned.ignored, unsupported: scanned.unsupported }, entrypoints, topDirectories, graph: graph.summary, suggestedReads, warnings: [], truncated: false };
  return { ...data, tokenEstimate: estimateTokens(JSON.stringify(data)) };
}

async function countFiles(root: string, inputPath: string): Promise<{ ignored: number; unsupported: number }> {
  const start = resolveInsideRoot(root, inputPath);
  let totalFiles = 0;
  let unsupported = 0;
  async function visit(absolutePath: string): Promise<void> {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(absolutePath)) await visit(path.join(absolutePath, entry));
      return;
    }
    if (!stat.isFile()) return;
    totalFiles += 1;
    if (!languageForPath(absolutePath)) unsupported += 1;
  }
  await visit(start);
  const indexed = (await walkSourceFiles(root, inputPath, { maxFiles: 10000 })).length;
  return { ignored: Math.max(0, totalFiles - unsupported - indexed), unsupported };
}

export function renderMap(data: Awaited<ReturnType<typeof projectMap>>): string {
  const langs = Object.entries(data.languages).map(([language, count]) => `${language} ${count}`).join(', ') || 'none';
  return `Project: .\nLanguages: ${langs}\nFiles: ${data.files.indexed} indexed, ${data.files.ignored} ignored, ${data.files.unsupported} unsupported\nGraph: ${data.graph.imports} imports (${data.graph.resolvedImports} resolved), ${data.graph.exports} exports\n\nEntrypoints:\n${data.entrypoints.map((item) => `  ${item}`).join('\n')}\n\nSuggested first reads:\n${data.suggestedReads.map((item) => `  codebone ${item.command} ${'path' in item ? item.path : ''}`).join('\n')}`;
}
