import fs from 'node:fs/promises';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { languageForPath } from '../languages/registry.js';
import { FileEntry } from '../types.js';
import { loadConfig } from './config.js';
import { createIgnoreMatcher, IgnoreMatcher } from './gitignore.js';
import { resolveInsideRoot, toRelative } from './paths.js';

const defaultExcludes = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '__pycache__/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'vendor/**',
  '.venv/**',
  'target/**',
  'bin/**',
  'obj/**',
  '.codebone/**',
];

export interface WalkOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  respectAiIgnore?: boolean;
}

export async function walkSourceFiles(root: string, inputPath = '.', options: WalkOptions = {}): Promise<FileEntry[]> {
  const start = resolveInsideRoot(root, inputPath);
  const config = await loadConfig(root);
  const ignoreMatcher = await loadIgnoreMatcher(root, options.respectAiIgnore !== false);
  const includePatterns = options.include ?? config.include;
  const includeMatchers = includePatterns.map((pattern) => new Minimatch(pattern, { dot: true }));
  const excludeMatchers = [...defaultExcludes, ...config.exclude, ...(options.exclude ?? [])].map((pattern) => new Minimatch(pattern, { dot: true }));
  const results: FileEntry[] = [];

  async function visit(absolutePath: string): Promise<void> {
    if (options.maxFiles && results.length >= options.maxFiles) return;
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) return;
    const relativePath = toRelative(root, absolutePath);
    if (stat.isDirectory()) {
      if (relativePath && isIgnored(ignoreMatcher, relativePath, true)) return;
      if (relativePath && excludeMatchers.some((matcher) => matcher.match(relativePath) || matcher.match(`${relativePath}/`))) return;
      const entries = await fs.readdir(absolutePath);
      for (const entry of entries.sort()) await visit(path.join(absolutePath, entry));
      return;
    }
    if (!stat.isFile()) return;
    if (relativePath && (isIgnored(ignoreMatcher, relativePath, false) || excludeMatchers.some((matcher) => matcher.match(relativePath)))) return;
    if (includeMatchers.length > 0 && !includeMatchers.some((matcher) => matcher.match(relativePath))) return;
    const language = languageForPath(relativePath);
    if (!language) return;
    results.push({ absolutePath, relativePath, language: language.id, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  await visit(start);
  return results;
}

async function loadIgnoreMatcher(root: string, respectAiIgnore: boolean): Promise<IgnoreMatcher> {
  const files = respectAiIgnore ? ['.gitignore', '.aiignore', '.codeboneignore'] : ['.gitignore'];
  const contents: string[] = [];
  for (const file of files) {
    try {
      contents.push(await fs.readFile(path.join(root, file), 'utf8'));
    } catch {
      // Ignore files are optional.
    }
  }
  return createIgnoreMatcher(contents);
}

function isIgnored(matcher: IgnoreMatcher, relativePath: string, directory: boolean): boolean {
  return matcher.ignores(relativePath) || (directory && matcher.ignores(`${relativePath}/`));
}
