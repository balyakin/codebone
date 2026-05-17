import fs from 'node:fs/promises';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { languageForPath } from '../languages/registry.js';
import { FileEntry } from '../types.js';
import { loadConfig } from './config.js';
import { CodeboneError, warning } from './errors.js';
import { createIgnoreMatcher, IgnoreMatcher } from './gitignore.js';
import { isInsideRoot, resolveInsideRoot, toRelative } from './paths.js';
import { cachedValue } from './runtime-cache.js';

export const defaultExcludePatterns = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.next/**',
  '.nuxt/**',
  '.svelte-kit/**',
  '.turbo/**',
  '.cache/**',
  'target/**',
  '.venv/**',
  'venv/**',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  '*.min.*',
  '*.map',
  '*.generated.*',
  '*.gen.*',
  '*.pb.go',
  '*_pb2.py',
  '*.designer.*',
  '.codebone/**',
];

const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.class',
  '.jar',
  '.pyc',
  '.pyo',
  '.sqlite',
  '.db',
]);

export interface WalkOptions {
  include?: string[];
  exclude?: string[];
  ignore?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
  respectAiIgnore?: boolean;
}

export interface WalkStats {
  totalFiles: number;
  ignored: number;
  binary: number;
  generated: number;
  tooLarge: number;
  unsupported: number;
  skipped: number;
  parseErrors: number;
}

export interface WalkResult {
  files: FileEntry[];
  stats: WalkStats;
  skippedFiles: Array<{ path: string; reason: string }>;
  warnings: string[];
  truncated: boolean;
  directoryMeta?: Array<{ path: string; size: number; mtimeMs: number }>;
}

export async function walkSourceFiles(root: string, inputPath = '.', options: WalkOptions = {}): Promise<FileEntry[]> {
  return (await walkSourceFilesDetailed(root, inputPath, options)).files;
}

export async function walkSourceFilesDetailed(root: string, inputPath = '.', options: WalkOptions = {}): Promise<WalkResult> {
  const config = await loadConfig(root);
  const maxFiles = options.maxFiles ?? config.maxFiles;
  const maxFileBytes = options.maxFileBytes ?? config.maxFileBytes;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const normalizedOptions = { ...options, maxFiles, maxFileBytes, timeoutMs, include: options.include ?? config.include };
  const cacheKey = [
    'walk',
    root,
    inputPath,
    JSON.stringify({
      maxFiles,
      maxFileBytes,
      timeoutMs,
      include: normalizedOptions.include,
      exclude: normalizedOptions.exclude,
      ignore: normalizedOptions.ignore,
      configIgnore: config.ignore,
      respectAiIgnore: normalizedOptions.respectAiIgnore !== false,
      followSymlinks: config.security.followSymlinks,
    }),
  ].join(':');
  return cachedValue(
    root,
    cacheKey,
    estimateWalkResultBytes,
    () => walkUncached(root, inputPath, normalizedOptions, config.ignore, config.security.followSymlinks),
    (cached) => isWalkCacheFresh(root, cached),
  );
}

async function walkUncached(root: string, inputPath: string, options: Required<Pick<WalkOptions, 'maxFiles' | 'maxFileBytes' | 'timeoutMs'>> & WalkOptions, configIgnore: string[], followSymlinks: boolean): Promise<WalkResult> {
  const startedAt = Date.now();
  const start = resolveInsideRoot(root, inputPath);
  const ignoreMatcher = await loadIgnoreMatcher(root, options.respectAiIgnore !== false);
  const includeMatchers = (options.include ?? []).map((pattern) => new Minimatch(pattern, { dot: true }));
  const excludeMatchers = [...defaultExcludePatterns, ...configIgnore, ...(options.exclude ?? []), ...(options.ignore ?? [])].map((pattern) => new Minimatch(pattern, { dot: true }));
  const results: FileEntry[] = [];
  const warnings: string[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  const directoryMeta: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const visitedDirectories = new Set<string>();
  const stats: WalkStats = { totalFiles: 0, ignored: 0, binary: 0, generated: 0, tooLarge: 0, unsupported: 0, skipped: 0, parseErrors: 0 };
  let truncated = false;

  async function visit(absolutePath: string): Promise<void> {
    if (Date.now() - startedAt > options.timeoutMs) {
      truncated = true;
      warnings.push(warning('TIMEOUT', `file discovery exceeded ${options.timeoutMs}ms`));
      return;
    }
    if (results.length >= options.maxFiles) {
      truncated = true;
      warnings.push(warning('TRUNCATED', `maxFiles ${options.maxFiles} reached`));
      return;
    }

    let stat;
    const originalPath = absolutePath;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (absolutePath === start) throw new CodeboneError('PATH_NOT_FOUND', `Path not found: ${inputPath}`);
        const relative = toRelative(root, absolutePath);
        stats.skipped += 1;
        skippedFiles.push({ path: relative, reason: 'vanished' });
        warnings.push(warning('PARSE_ERROR', `${relative}:vanished`));
        return;
      }
      if (isPermissionError(error)) {
        const relative = toRelative(root, absolutePath);
        stats.skipped += 1;
        skippedFiles.push({ path: relative, reason: 'unreadable' });
        warnings.push(warning('PARSE_ERROR', `${relative}:unreadable`));
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!followSymlinks) return;
      const real = await fs.realpath(absolutePath);
      if (!isInsideRoot(root, real)) {
        stats.skipped += 1;
        skippedFiles.push({ path: toRelative(root, originalPath), reason: 'symlink_outside_root' });
        return;
      }
      absolutePath = real;
      stat = await fs.stat(absolutePath);
    }
    const relativePath = toRelative(root, originalPath);
    const relativeForMatch = relativePath || '.';

    if (stat.isDirectory()) {
      const realDirectory = await fs.realpath(absolutePath).catch(() => absolutePath);
      if (visitedDirectories.has(realDirectory)) return;
      visitedDirectories.add(realDirectory);
      directoryMeta.push({ path: relativePath || '.', size: stat.size, mtimeMs: stat.mtimeMs });
      if (relativePath && shouldIgnorePath(ignoreMatcher, excludeMatchers, relativePath, true)) {
        stats.ignored += 1;
        stats.skipped += 1;
        return;
      }
      let entries: string[];
      try {
        entries = await fs.readdir(absolutePath);
      } catch (error) {
        if (isPermissionError(error)) {
          stats.skipped += 1;
          skippedFiles.push({ path: relativePath, reason: 'unreadable' });
          warnings.push(warning('PARSE_ERROR', `${relativePath}:unreadable`));
          return;
        }
        throw error;
      }
      for (const entry of entries.sort()) {
        if (truncated) break;
        await visit(path.join(absolutePath, entry));
      }
      return;
    }

    if (!stat.isFile()) return;
    stats.totalFiles += 1;

    if (relativePath && shouldIgnorePath(ignoreMatcher, excludeMatchers, relativePath, false)) {
      stats.ignored += 1;
      stats.skipped += 1;
      skippedFiles.push({ path: relativePath, reason: 'ignored' });
      return;
    }
    if (includeMatchers.length > 0 && !includeMatchers.some((matcher) => matcher.match(relativeForMatch))) {
      stats.ignored += 1;
      stats.skipped += 1;
      skippedFiles.push({ path: relativePath, reason: 'include_filter' });
      return;
    }
    if (isGenerated(relativePath)) {
      stats.generated += 1;
      stats.skipped += 1;
      skippedFiles.push({ path: relativePath, reason: 'generated' });
      return;
    }
    if (isBinaryExtension(relativePath) || await looksBinary(absolutePath).catch((error: unknown) => {
      if (isPermissionError(error)) return true;
      throw error;
    })) {
      stats.binary += 1;
      stats.skipped += 1;
      skippedFiles.push({ path: relativePath, reason: 'binary' });
      return;
    }
    if (stat.size > options.maxFileBytes) {
      stats.tooLarge += 1;
      stats.skipped += 1;
      skippedFiles.push({ path: relativePath, reason: 'file_too_large' });
      return;
    }
    const language = languageForPath(relativePath);
    if (!language) {
      stats.unsupported += 1;
      return;
    }
    results.push({ absolutePath, relativePath, language: language.id, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  await visit(start);
  if (stats.skipped > 0) warnings.push(warning('IGNORED_FILES_SKIPPED', `skipped ${stats.skipped} ignored/binary/generated/large files`));
  return { files: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), stats, skippedFiles, warnings, truncated, directoryMeta };
}

async function isWalkCacheFresh(root: string, result: WalkResult): Promise<boolean> {
  try {
    for (const directory of result.directoryMeta ?? []) {
      const stat = await fs.stat(resolveInsideRoot(root, directory.path));
      if (stat.size !== directory.size || stat.mtimeMs !== directory.mtimeMs) return false;
    }
    for (const file of result.files) {
      const stat = await fs.stat(file.absolutePath);
      if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function estimateWalkResultBytes(result: WalkResult): number {
  return Math.max(1, result.files.length * 180 + (result.directoryMeta?.length ?? 0) * 80 + result.skippedFiles.length * 80);
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
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

function shouldIgnorePath(matcher: IgnoreMatcher, excludes: Minimatch[], relativePath: string, directory: boolean): boolean {
  const dirPath = directory ? `${relativePath}/` : relativePath;
  return matcher.ignores(relativePath)
    || (directory && matcher.ignores(dirPath))
    || excludes.some((candidate) => candidate.match(relativePath) || (directory && candidate.match(dirPath)));
}

function isGenerated(relativePath: string): boolean {
  return /(?:^|\/)[^/]+(?:\.min\.|\.generated\.|\.gen\.|\.designer\.)|(?:^|\/)[^/]+\.pb\.go$|(?:^|\/)[^/]+_pb2\.py$/.test(relativePath);
}

function isBinaryExtension(relativePath: string): boolean {
  return binaryExtensions.has(path.extname(relativePath).toLowerCase());
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
